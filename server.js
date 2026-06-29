const express = require('express');
const { Pool } = require('pg');
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

// Test connection
pool.query('SELECT 1')
  .then(() => console.log('Database pool initialized successfully.'))
  .catch(err => console.error('Database pool initialization failed:', err));

// Multer Storage Configuration for Logo uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `logo_${Date.now()}${ext}`);
  }
});

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
      'SELECT id, category_id, question_text, sort_order, weight FROM survey_questions WHERE is_active = 1 ORDER BY sort_order ASC'
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

    // 2. Fetch questions weights to calculate scores
    const questionsResult = await client.query(
      'SELECT id, weight FROM survey_questions WHERE is_active = 1'
    );
    const questions = questionsResult.rows;
    const qMap = {};
    questions.forEach(q => { qMap[q.id] = q.weight; });

    let totalScore = 0;
    let maxPossibleScore = 0;

    // 3. Insert Answers and calculate score
    for (const ans of answers) {
      const qId = parseInt(ans.question_id);
      const rating = parseInt(ans.rating_value);

      if (isNaN(qId) || isNaN(rating) || rating < 1 || rating > 5) {
        throw new Error(`Invalid response for question ID ${ans.question_id}`);
      }

      await client.query(
        'INSERT INTO survey_answers (respondent_id, question_id, rating_value) VALUES ($1, $2, $3)',
        [respondentId, qId, rating]
      );

      const weight = qMap[qId] !== undefined ? qMap[qId] : 1;
      totalScore += (rating * weight);
      maxPossibleScore += (5 * weight);
    }

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
  let dateFilter = '';
  const params = [];

  if (startDate && endDate) {
    dateFilter = 'WHERE r.submitted_at BETWEEN $1 AND $2';
    params.push(`${startDate} 00:00:00`, `${endDate} 23:59:59`);
  }

  try {
    // 1. Total respondents
    const respResult = await pool.query(`SELECT COUNT(*) as total FROM respondents r ${dateFilter}`, params);
    const totalRespondents = parseInt(respResult.rows[0].total);

    // 2. Average satisfaction score and percentage
    const avgResult = await pool.query(`
      SELECT AVG(sr.percentage) as avg_percent
      FROM survey_results sr
      INNER JOIN respondents r ON sr.respondent_id = r.id
      ${dateFilter}
    `, params);
    const overallSatisfaction = avgResult.rows[0].avg_percent ? parseFloat(parseFloat(avgResult.rows[0].avg_percent).toFixed(2)) : 0;

    // 3. Distribution of ratings
    const predResult = await pool.query(`
      SELECT sr.predicate, COUNT(*) as count
      FROM survey_results sr
      INNER JOIN respondents r ON sr.respondent_id = r.id
      ${dateFilter}
      GROUP BY sr.predicate
    `, params);
    const predicatesDistribution = predResult.rows;

    // 4. Score by categories
    const categoryScoresResult = await pool.query(`
      SELECT sc.id, sc.name, AVG(sa.rating_value) as avg_rating
      FROM survey_answers sa
      INNER JOIN survey_questions sq ON sa.question_id = sq.id
      INNER JOIN survey_categories sc ON sq.category_id = sc.id
      INNER JOIN respondents r ON sa.respondent_id = r.id
      ${dateFilter}
      GROUP BY sc.id, sc.name
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
  let dateFilter = '';
  const params = [];

  if (startDate && endDate) {
    dateFilter = 'WHERE r.submitted_at BETWEEN $1 AND $2';
    params.push(`${startDate} 00:00:00`, `${endDate} 23:59:59`);
  }

  try {
    // 1. Avg rating per category
    const catResult = await pool.query(`
      SELECT sc.name, AVG(sa.rating_value) as avg_score
      FROM survey_answers sa
      INNER JOIN survey_questions sq ON sa.question_id = sq.id
      INNER JOIN survey_categories sc ON sq.category_id = sc.id
      INNER JOIN respondents r ON sa.respondent_id = r.id
      ${dateFilter}
      GROUP BY sc.id, sc.name
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
      ${dateFilter}
      GROUP BY sq.id, sq.question_text, sc.name
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
      SELECT sa.respondent_id, sa.question_id, sq.question_text, sc.name as category_name, sa.rating_value
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
  const { category_id, question_text, sort_order, is_active, weight } = req.body;

  if (!category_id || !question_text) {
    return res.status(400).json({ error: 'Category and question text are required' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO survey_questions (category_id, question_text, sort_order, is_active, weight) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [category_id, question_text, sort_order || 0, is_active !== undefined ? is_active : 1, weight !== undefined ? weight : 1]
    );
    res.status(201).json({ id: result.rows[0].id, category_id, question_text, sort_order, is_active, weight });
  } catch (error) {
    res.status(500).json({ error: 'Error creating question' });
  }
});

app.put('/api/admin/questions/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { category_id, question_text, sort_order, is_active, weight } = req.body;

  if (!category_id || !question_text) {
    return res.status(400).json({ error: 'Category and question text are required' });
  }

  try {
    await pool.query(
      'UPDATE survey_questions SET category_id = $1, question_text = $2, sort_order = $3, is_active = $4, weight = $5 WHERE id = $6',
      [category_id, question_text, sort_order, is_active, weight, id]
    );
    res.json({ success: true, id, category_id, question_text, sort_order, is_active, weight });
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

// Logo upload route
app.post('/api/admin/settings/logo', authenticateToken, upload.single('logo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file uploaded' });
  }

  try {
    // Get existing logo path to delete old file
    const { rows } = await pool.query('SELECT setting_value FROM settings WHERE setting_key = $1', ['logo_path']);
    if (rows.length > 0 && rows[0].setting_value) {
      const oldLogoPath = path.join(__dirname, 'public', rows[0].setting_value);
      if (fs.existsSync(oldLogoPath)) {
        try {
          fs.unlinkSync(oldLogoPath);
          console.log(`Deleted old logo file: ${oldLogoPath}`);
        } catch (unlinkErr) {
          console.error('Error deleting old logo file:', unlinkErr);
        }
      }
    }

    // Save the new logo path
    const relativePath = `/uploads/${req.file.filename}`;
    await pool.query(
      `INSERT INTO settings (setting_key, setting_value) VALUES ($1, $2) 
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = CURRENT_TIMESTAMP`,
      ['logo_path', relativePath]
    );

    res.json({ success: true, logo_path: relativePath });
  } catch (error) {
    console.error('Error saving uploaded logo:', error);
    res.status(500).json({ error: 'Internal server error during logo saving' });
  }
});

// Delete logo (reset branding)
app.delete('/api/admin/settings/logo', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT setting_value FROM settings WHERE setting_key = $1', ['logo_path']);
    if (rows.length > 0 && rows[0].setting_value) {
      const oldLogoPath = path.join(__dirname, 'public', rows[0].setting_value);
      if (fs.existsSync(oldLogoPath)) {
        fs.unlinkSync(oldLogoPath);
      }
    }
    await pool.query('UPDATE settings SET setting_value = $1 WHERE setting_key = $2', ['', 'logo_path']);
    res.json({ success: true, message: 'Logo reset successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Error resetting logo' });
  }
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
