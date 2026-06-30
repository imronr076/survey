const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'bina_css_super_secret_key_123_pt_bina';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ensure uploads folder exists
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Database Connection Pool
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'defaultdb',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test connection and auto-create indexes/migrations if not exist
pool.query('SELECT 1')
  .then(async () => {
    console.log('Database pool initialized successfully.');
    try {
      // Create Indexes
      await pool.query('CREATE INDEX IF NOT EXISTS idx_survey_answers_respondent_id ON survey_answers(respondent_id);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_survey_answers_question_id ON survey_answers(question_id);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_survey_questions_category_id ON survey_questions(category_id);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_respondents_submitted_at ON respondents(submitted_at);');
      console.log('Database indexes verified/created successfully.');

      // Schema migrations
      await pool.query("ALTER TABLE survey_questions ADD COLUMN IF NOT EXISTS question_type VARCHAR(20) DEFAULT 'star';");
      await pool.query("ALTER TABLE survey_answers ADD COLUMN IF NOT EXISTS text_value TEXT NULL;");
      await pool.query("ALTER TABLE survey_answers ALTER COLUMN rating_value DROP NOT NULL;");
      console.log('Database schema migrations verified/applied successfully.');
    } catch (migErr) {
      console.error('Failed to run startup migrations/indexes:', migErr);
    }
  })
  .catch(err => console.error('Database pool initialization failed:', err));

// Multer Storage Configuration for Logo uploads (Using Memory Storage for Serverless environments)
const storage = multer.memoryStorage();

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|gif|svg/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Only images are allowed'));
  },
  limits: { fileSize: 2 * 1024 * 1024 } // 2MB limit
});

// JWT Authorization Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access denied. Token missing.' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token.' });
    }
    req.user = user;
    next();
  });
}

// Calculate predicate from percentage
function getPredicate(percentage) {
  if (percentage <= 20) return 'Sangat Tidak Puas';
  if (percentage <= 40) return 'Tidak Puas';
  if (percentage <= 60) return 'Cukup Puas';
  if (percentage <= 80) return 'Puas';
  return 'Sangat Puas';
}

// ==========================================
// 1. PUBLIC APIS
// ==========================================

// Get survey settings
app.get('/api/survey/config', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT setting_key, setting_value FROM settings');
    const config = {};
    rows.forEach(row => {
      config[row.setting_key] = row.setting_value;
    });
    res.json(config);
  } catch (error) {
    console.error('Error fetching survey config:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get active categories & active questions
app.get('/api/survey/questions', async (req, res) => {
  try {
    const { rows: categories } = await pool.query(
      'SELECT id, name, description FROM survey_categories WHERE is_active = 1 ORDER BY sort_order ASC'
    );
    const { rows: questions } = await pool.query(
      'SELECT id, category_id, question_text, question_type, sort_order, weight FROM survey_questions WHERE is_active = 1 ORDER BY sort_order ASC'
    );

    const data = categories.map(cat => {
      return {
        ...cat,
        questions: questions.filter(q => q.category_id === cat.id)
      };
    }).filter(cat => cat.questions.length > 0); // Only return categories that have questions

    res.json(data);
  } catch (error) {
    console.error('Error fetching survey questions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Submit survey responses
app.post('/api/survey/submit', async (req, res) => {
  const { is_anonymous, name, department, answers } = req.body;

  // Validate answers
  if (!answers || !Array.isArray(answers) || answers.length === 0) {
    return res.status(400).json({ error: 'Answers are required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Insert Respondent
    const isAnonVal = is_anonymous ? 1 : 0;
    const respName = is_anonymous ? null : name;
    const respDept = is_anonymous ? null : department;

    const respResult = await client.query(
      'INSERT INTO respondents (name, department, is_anonymous) VALUES ($1, $2, $3) RETURNING id',
      [respName, respDept, isAnonVal]
    );
    const respondentId = respResult.rows[0].id;

    // 2. Fetch questions weights and types to calculate scores
    const questionsResult = await client.query(
      'SELECT id, weight, question_type FROM survey_questions WHERE is_active = 1'
    );
    const questions = questionsResult.rows;
    const qMap = {};
    questions.forEach(q => {
      qMap[q.id] = { weight: q.weight, type: q.question_type || 'star' };
    });

    let totalScore = 0;
    let maxPossibleScore = 0;

    // 3. Prepare Answers data and calculate score
    const insertValues = [];
    const insertPlaceholders = [];
    let paramIndex = 1;

    for (const ans of answers) {
      const qId = parseInt(ans.question_id);
      const qMeta = qMap[qId] || { weight: 1, type: 'star' };

      let rating = null;
      let textVal = null;

      if (qMeta.type === 'text') {
        textVal = ans.text_value !== undefined && ans.text_value !== null ? String(ans.text_value).trim() : null;
        // Text responses do not affect rating calculations.
      } else {
        // Star rating
        rating = parseInt(ans.rating_value);
        if (isNaN(qId) || isNaN(rating) || rating < 1 || rating > 5) {
          throw new Error(`Invalid response for question ID ${ans.question_id}`);
        }
        const weight = qMeta.weight;
        totalScore += (rating * weight);
        maxPossibleScore += (5 * weight);
      }

      insertPlaceholders.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3})`);
      insertValues.push(respondentId, qId, rating, textVal);
      paramIndex += 4;
    }

    const insertAnswersQuery = `
      INSERT INTO survey_answers (respondent_id, question_id, rating_value, text_value) 
      VALUES ${insertPlaceholders.join(', ')}
    `;
    await client.query(insertAnswersQuery, insertValues);

    // Calculate percentage and predicate
    const percentage = maxPossibleScore > 0 ? parseFloat(((totalScore / maxPossibleScore) * 100).toFixed(2)) : 0;
    const predicate = getPredicate(percentage);

    // 4. Insert Survey Result
    await client.query(
      'INSERT INTO survey_results (respondent_id, total_score, percentage, predicate) VALUES ($1, $2, $3, $4)',
      [respondentId, totalScore, percentage, predicate]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      respondentId,
      totalScore,
      percentage,
      predicate
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error submitting survey:', error);
    res.status(400).json({ error: error.message || 'Error processing survey submission.' });
  } finally {
    client.release();
  }
});


// ==========================================
// 2. ADMIN AUTH APIS
// ==========================================

// Login Route
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const admin = rows[0];
    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = jwt.sign({ id: admin.id, username: admin.username }, JWT_SECRET, { expiresIn: '12h' });

    res.json({
      success: true,
      token,
      admin: {
        username: admin.username,
        name: admin.name
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});


// ==========================================
// 3. SECURE ADMIN DASHBOARD APIS
// ==========================================

// Get high level dashboard stats
app.get('/api/admin/dashboard-stats', authenticateToken, async (req, res) => {
  const { startDate, endDate } = req.query;
  const params = [];
  const respWhereClauses = [];
  const joinWhereClauses = ["sq.question_type = 'star'"];

  if (startDate && endDate) {
    respWhereClauses.push('r.submitted_at BETWEEN $1 AND $2');
    joinWhereClauses.push('r.submitted_at BETWEEN $1 AND $2');
    params.push(`${startDate} 00:00:00`, `${endDate} 23:59:59`);
  }

  const respWhereFilter = respWhereClauses.length > 0 ? 'WHERE ' + respWhereClauses.join(' AND ') : '';
  const joinWhereFilter = 'WHERE ' + joinWhereClauses.join(' AND ');

  try {
    // 1. Total respondents
    const respResult = await pool.query(`SELECT COUNT(*) as total FROM respondents r ${respWhereFilter}`, params);
    const totalRespondents = parseInt(respResult.rows[0].total);

    // 2. Average satisfaction score and percentage
    const avgResult = await pool.query(`
      SELECT AVG(sr.percentage) as avg_percent
      FROM survey_results sr
      INNER JOIN respondents r ON sr.respondent_id = r.id
      ${respWhereFilter}
    `, params);
    const overallSatisfaction = avgResult.rows[0].avg_percent ? parseFloat(parseFloat(avgResult.rows[0].avg_percent).toFixed(2)) : 0;

    // 3. Distribution of ratings
    const predResult = await pool.query(`
      SELECT sr.predicate, COUNT(*) as count
      FROM survey_results sr
      INNER JOIN respondents r ON sr.respondent_id = r.id
      ${respWhereFilter}
      GROUP BY sr.predicate
    `, params);
    const predicatesDistribution = predResult.rows;

    // 4. Score by categories (only star questions)
    const categoryScoresResult = await pool.query(`
      SELECT sc.id, sc.name, AVG(sa.rating_value) as avg_rating
      FROM survey_answers sa
      INNER JOIN survey_questions sq ON sa.question_id = sq.id
      INNER JOIN survey_categories sc ON sq.category_id = sc.id
      INNER JOIN respondents r ON sa.respondent_id = r.id
      ${joinWhereFilter}
      GROUP BY sc.id, sc.name, sc.sort_order
      ORDER BY sc.sort_order ASC
    `, params);
    const categoryScores = categoryScoresResult.rows;

    res.json({
      totalRespondents,
      overallSatisfaction,
      predicatesDistribution,
      categoryScores: categoryScores.map(cs => ({
        ...cs,
        avg_rating: cs.avg_rating ? parseFloat(parseFloat(cs.avg_rating).toFixed(2)) : 0
      }))
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Detailed chart data (by category & by question)
app.get('/api/admin/charts', authenticateToken, async (req, res) => {
  const { startDate, endDate } = req.query;
  const params = [];
  const joinWhereClauses = ["sq.question_type = 'star'"];

  if (startDate && endDate) {
    joinWhereClauses.push('r.submitted_at BETWEEN $1 AND $2');
    params.push(`${startDate} 00:00:00`, `${endDate} 23:59:59`);
  }

  const joinWhereFilter = 'WHERE ' + joinWhereClauses.join(' AND ');

  try {
    // 1. Avg rating per category
    const catResult = await pool.query(`
      SELECT sc.name, AVG(sa.rating_value) as avg_score
      FROM survey_answers sa
      INNER JOIN survey_questions sq ON sa.question_id = sq.id
      INNER JOIN survey_categories sc ON sq.category_id = sc.id
      INNER JOIN respondents r ON sa.respondent_id = r.id
      ${joinWhereFilter}
      GROUP BY sc.id, sc.name, sc.sort_order
      ORDER BY sc.sort_order ASC
    `, params);
    const categoryData = catResult.rows;

    // 2. Avg rating per question
    const qResult = await pool.query(`
      SELECT sq.id, sq.question_text, sc.name as category_name, AVG(sa.rating_value) as avg_score
      FROM survey_answers sa
      INNER JOIN survey_questions sq ON sa.question_id = sq.id
      INNER JOIN survey_categories sc ON sq.category_id = sc.id
      INNER JOIN respondents r ON sa.respondent_id = r.id
      ${joinWhereFilter}
      GROUP BY sq.id, sq.question_text, sc.name, sc.sort_order, sq.sort_order
      ORDER BY sc.sort_order ASC, sq.sort_order ASC
    `, params);
    const questionData = qResult.rows;

    res.json({
      categories: categoryData.map(c => ({ name: c.name, avg_score: parseFloat(c.avg_score || 0).toFixed(2) })),
      questions: questionData.map(q => ({
        id: q.id,
        question: q.question_text,
        category: q.category_name,
        avg_score: parseFloat(q.avg_score || 0).toFixed(2)
      }))
    });
  } catch (error) {
    console.error('Error fetching charts data:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List of respondents with answers
app.get('/api/admin/respondents', authenticateToken, async (req, res) => {
  const { startDate, endDate } = req.query;
  let dateFilter = '';
  const params = [];

  if (startDate && endDate) {
    dateFilter = 'WHERE r.submitted_at BETWEEN $1 AND $2';
    params.push(`${startDate} 00:00:00`, `${endDate} 23:59:59`);
  }

  try {
    // Get respondents summaries
    const respResult = await pool.query(`
      SELECT r.id, r.name, r.department, r.is_anonymous, r.submitted_at, sr.total_score, sr.percentage, sr.predicate
      FROM respondents r
      INNER JOIN survey_results sr ON r.id = sr.respondent_id
      ${dateFilter}
      ORDER BY r.submitted_at DESC
    `, params);
    const respondents = respResult.rows;

    // Get detailed answers for all
    const ansResult = await pool.query(`
      SELECT sa.respondent_id, sa.question_id, sq.question_text, sq.question_type, sc.name as category_name, sa.rating_value, sa.text_value
      FROM survey_answers sa
      INNER JOIN survey_questions sq ON sa.question_id = sq.id
      INNER JOIN survey_categories sc ON sq.category_id = sc.id
    `);
    const answers = ansResult.rows;

    const data = respondents.map(resp => {
      return {
        ...resp,
        answers: answers.filter(ans => ans.respondent_id === resp.id)
      };
    });

    res.json(data);
  } catch (error) {
    console.error('Error fetching respondents list:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete a respondent and their survey responses
app.delete('/api/admin/respondents/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM respondents WHERE id = $1', [id]);
    res.json({ success: true, message: 'Tanggapan responden berhasil dihapus' });
  } catch (error) {
    console.error('Error deleting respondent:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// ==========================================
// 4. SECURE CATEGORY CRUD
// ==========================================

app.get('/api/admin/categories', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM survey_categories ORDER BY sort_order ASC');
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching categories' });
  }
});

app.post('/api/admin/categories', authenticateToken, async (req, res) => {
  const { name, description, sort_order, is_active } = req.body;
  if (!name) return res.status(400).json({ error: 'Category name is required' });

  try {
    const result = await pool.query(
      'INSERT INTO survey_categories (name, description, sort_order, is_active) VALUES ($1, $2, $3, $4) RETURNING id',
      [name, description || '', sort_order || 0, is_active !== undefined ? is_active : 1]
    );
    res.status(201).json({ id: result.rows[0].id, name, description, sort_order, is_active });
  } catch (error) {
    res.status(500).json({ error: 'Error creating category' });
  }
});

app.put('/api/admin/categories/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { name, description, sort_order, is_active } = req.body;

  if (!name) return res.status(400).json({ error: 'Category name is required' });

  try {
    await pool.query(
      'UPDATE survey_categories SET name = $1, description = $2, sort_order = $3, is_active = $4 WHERE id = $5',
      [name, description, sort_order, is_active, id]
    );
    res.json({ success: true, id, name, description, sort_order, is_active });
  } catch (error) {
    res.status(500).json({ error: 'Error updating category' });
  }
});

app.delete('/api/admin/categories/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM survey_categories WHERE id = $1', [id]);
    res.json({ success: true, message: 'Category deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Error deleting category. It may have linked questions.' });
  }
});


// ==========================================
// 5. SECURE QUESTION CRUD
// ==========================================

app.get('/api/admin/questions', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT sq.*, sc.name as category_name 
      FROM survey_questions sq 
      INNER JOIN survey_categories sc ON sq.category_id = sc.id 
      ORDER BY sc.sort_order ASC, sq.sort_order ASC
    `);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching questions' });
  }
});

app.post('/api/admin/questions', authenticateToken, async (req, res) => {
  const { category_id, question_text, question_type, sort_order, is_active, weight } = req.body;

  if (!category_id || !question_text) {
    return res.status(400).json({ error: 'Category and question text are required' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO survey_questions (category_id, question_text, question_type, sort_order, is_active, weight) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [category_id, question_text, question_type || 'star', sort_order || 0, is_active !== undefined ? is_active : 1, weight !== undefined ? weight : 1]
    );
    res.status(201).json({ id: result.rows[0].id, category_id, question_text, question_type, sort_order, is_active, weight });
  } catch (error) {
    res.status(500).json({ error: 'Error creating question' });
  }
});

app.put('/api/admin/questions/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { category_id, question_text, question_type, sort_order, is_active, weight } = req.body;

  if (!category_id || !question_text) {
    return res.status(400).json({ error: 'Category and question text are required' });
  }

  try {
    await pool.query(
      'UPDATE survey_questions SET category_id = $1, question_text = $2, question_type = $3, sort_order = $4, is_active = $5, weight = $6 WHERE id = $7',
      [category_id, question_text, question_type || 'star', sort_order, is_active, weight, id]
    );
    res.json({ success: true, id, category_id, question_text, question_type, sort_order, is_active, weight });
  } catch (error) {
    res.status(500).json({ error: 'Error updating question' });
  }
});

app.delete('/api/admin/questions/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM survey_questions WHERE id = $1', [id]);
    res.json({ success: true, message: 'Question deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Error deleting question' });
  }
});


// ==========================================
// 6. SECURE SETTINGS & LOGO
// ==========================================

// Save settings key-values
app.post('/api/admin/settings', authenticateToken, async (req, res) => {
  const { survey_title, welcome_text, show_identity } = req.body;

  try {
    const keys = { survey_title, welcome_text, show_identity };
    for (const [key, val] of Object.entries(keys)) {
      if (val !== undefined) {
        await pool.query(
          `INSERT INTO settings (setting_key, setting_value) VALUES ($1, $2) 
           ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = CURRENT_TIMESTAMP`,
          [key, String(val)]
        );
      }
    }
    res.json({ success: true, message: 'Settings updated successfully' });
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ error: 'Error saving settings' });
  }
});

function hexSha256(stringOrBuffer) {
  return crypto.createHash('sha256').update(stringOrBuffer).digest('hex');
}

function hmacSha256(key, string) {
  return crypto.createHmac('sha256', key).update(string).digest();
}

function getSignatureKey(key, dateStamp, regionName, serviceName) {
  const kDate = hmacSha256('AWS4' + key, dateStamp);
  const kRegion = hmacSha256(kDate, regionName);
  const kService = hmacSha256(kRegion, serviceName);
  const kSigning = hmacSha256(kService, 'aws4_request');
  return kSigning;
}

// S3 V4 Signature cURL upload implementation in Node.js
async function uploadToS3(fileBuffer, mimetype) {
  const ACCESS_KEY = "GK44391cb62433dffc48539039";
  const SECRET_KEY = "cf8eff575be3d9245908cf72f8e844db76f604fd9742852c36fcaee34b59d3df";
  const BUCKET = "bina";
  const ENDPOINT = "cdn.api57.web.id";
  const FILE_KEY = `logo/bina_${Date.now()}.jpg`;
  const REGION = "garage";
  const SERVICE = "s3";

  const canonicalUri = `/${BUCKET}/${FILE_KEY}`;
  const canonicalQuery = "";
  
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]/g, "").split(".")[0] + "Z";
  const dateStamp = amzDate.substring(0, 8);

  const payloadHash = hexSha256(fileBuffer);
  
  const canonicalHeaders = `host:${ENDPOINT}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest = `PUT\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const canonicalRequestHash = hexSha256(canonicalRequest);

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${canonicalRequestHash}`;

  const signingKey = getSignatureKey(SECRET_KEY, dateStamp, REGION, SERVICE);
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const authorizationHeader = `${algorithm} Credential=${ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `https://${ENDPOINT}${canonicalUri}`;
  const contentType = mimetype || "image/jpeg";

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Host": ENDPOINT,
      "Content-Type": contentType,
      "X-Amz-Date": amzDate,
      "X-Amz-Content-SHA256": payloadHash,
      "Authorization": authorizationHeader
    },
    body: fileBuffer
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`S3 upload failed: ${response.status} - ${errorText}`);
  }

  return `https://${BUCKET}.cdn-bina.web.id/${FILE_KEY}`;
}

// Logo upload route (S3 Integration)
app.post('/api/admin/settings/logo', authenticateToken, upload.single('logo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file uploaded' });
  }

  try {
    // Upload to S3
    const s3Url = await uploadToS3(req.file.buffer, req.file.mimetype);

    // Save the S3 URL directly in settings table
    await pool.query(
      `INSERT INTO settings (setting_key, setting_value) VALUES ($1, $2) 
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = CURRENT_TIMESTAMP`,
      ['logo_path', s3Url]
    );

    res.json({ success: true, logo_path: s3Url });
  } catch (error) {
    console.error('Error saving uploaded logo to S3:', error);
    res.status(500).json({ error: error.message || 'Internal server error during logo saving' });
  }
});

// Delete logo (reset branding)
app.delete('/api/admin/settings/logo', authenticateToken, async (req, res) => {
  try {
    await pool.query('UPDATE settings SET setting_value = $1 WHERE setting_key = $2', ['', 'logo_path']);
    res.json({ success: true, message: 'Logo reset successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Error resetting logo' });
  }
});


// Redirect /admin and /admin/ to login page
app.get('/admin', (req, res) => {
  res.redirect('/admin/login.html');
});
app.get('/admin/', (req, res) => {
  res.redirect('/admin/login.html');
});

// Catch-all for html pages inside admin or public, so we redirect cleanly or serve them
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start express server
app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
