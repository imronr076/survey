const { Client } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASS || 'postgres',
  database: process.env.DB_NAME || 'bina-survey',
  ssl: process.env.DB_SSL === 'false' ? { rejectUnauthorized: false } : undefined
};

async function setup() {
  let client;
  try {
    console.log(`Connecting to PostgreSQL at ${dbConfig.host}:${dbConfig.port}...`);
    client = new Client(dbConfig);
    await client.connect();
    console.log('Connected to PostgreSQL server.');

    // Create Tables
    console.log('Initializing database tables...');

    // 1. Settings
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        setting_key VARCHAR(50) UNIQUE NOT NULL,
        setting_value TEXT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Users
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        name VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 3. Survey Categories
    await client.query(`
      CREATE TABLE IF NOT EXISTS survey_categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT NULL,
        sort_order INT DEFAULT 0,
        is_active SMALLINT DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 4. Survey Questions
    await client.query(`
      CREATE TABLE IF NOT EXISTS survey_questions (
        id SERIAL PRIMARY KEY,
        category_id INT NOT NULL,
        question_text TEXT NOT NULL,
        question_type VARCHAR(100) DEFAULT 'star',
        is_active SMALLINT DEFAULT 1,
        sort_order INT DEFAULT 0,
        weight INT DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (category_id) REFERENCES survey_categories(id) ON DELETE CASCADE
      );
    `);

    // 5. Respondents
    await client.query(`
      CREATE TABLE IF NOT EXISTS respondents (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NULL,
        department VARCHAR(100) NULL,
        is_anonymous SMALLINT DEFAULT 0,
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 6. Survey Answers
    await client.query(`
      CREATE TABLE IF NOT EXISTS survey_answers (
        id SERIAL PRIMARY KEY,
        respondent_id INT NOT NULL,
        question_id INT NOT NULL,
        rating_value INT NULL,
        text_value TEXT NULL,
        FOREIGN KEY (respondent_id) REFERENCES respondents(id) ON DELETE CASCADE,
        FOREIGN KEY (question_id) REFERENCES survey_questions(id) ON DELETE CASCADE
      );
    `);

    // 7. Survey Results
    await client.query(`
      CREATE TABLE IF NOT EXISTS survey_results (
        id SERIAL PRIMARY KEY,
        respondent_id INT NOT NULL UNIQUE,
        total_score INT NOT NULL,
        percentage DECIMAL(5,2) NOT NULL,
        predicate VARCHAR(50) NOT NULL,
        FOREIGN KEY (respondent_id) REFERENCES respondents(id) ON DELETE CASCADE
      );
    `);

    // Create Indexes for query optimization
    console.log('Creating database indexes...');
    await client.query('CREATE INDEX IF NOT EXISTS idx_survey_answers_respondent_id ON survey_answers(respondent_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_survey_answers_question_id ON survey_answers(question_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_survey_questions_category_id ON survey_questions(category_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_respondents_submitted_at ON respondents(submitted_at);');
    console.log('Database indexes created successfully.');

    console.log('Tables initialized successfully.');

    // Seed Data
    console.log('Seeding default data...');

    // Seed Settings
    const defaultSettings = [
      { key: 'survey_title', value: 'PT. BINA CUSTOMER SATISFACTION SURVEY' },
      { key: 'welcome_text', value: 'Terima kasih telah menggunakan layanan PT. BINA. Kami sangat menghargai waktu dan masukan Anda. Survey ini bertujuan untuk meningkatkan kualitas layanan dan sistem yang kami berikan.' },
      { key: 'logo_path', value: '' }, // Empty means use default SVG text logo
      { key: 'show_identity', value: '1' } // '1' = active, '0' = inactive
    ];

    for (const setting of defaultSettings) {
      await client.query(
        `INSERT INTO settings (setting_key, setting_value) VALUES ($1, $2) 
         ON CONFLICT (setting_key) DO NOTHING`,
        [setting.key, setting.value]
      );
    }
    console.log('Settings seeded.');

    // Seed Admin User
    const existingUsers = await client.query('SELECT id FROM users WHERE username = $1', ['admin']);
    if (existingUsers.rows.length === 0) {
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash('admin123', salt);
      await client.query(
        'INSERT INTO users (username, password, name) VALUES ($1, $2, $3)',
        ['admin', hashedPassword, 'Administrator BINA']
      );
      console.log('Default administrator created (username: admin, password: admin123).');
    } else {
      console.log('Admin user already exists. Skipping...');
    }

    // Seed Categories and Questions
    const defaultCategories = [
      {
        name: 'Quality',
        description: 'Kualitas dan performansi aplikasi',
        sort: 1,
        questions: [
          'Gimana kualitas aplikasinya?',
          'Gimana kecepatannya?',
          'Aplikasinya stabil?',
          'Datanya akurat?',
          'Puas dengan performanya?'
        ]
      },
      {
        name: 'Services',
        description: 'Kualitas pelayanan tim IT',
        sort: 2,
        questions: [
          'Respon tim IT?',
          'Penyelesaian masalah?',
          'Sikap tim IT?',
          'Komunikasi tim IT?',
          'Pelayanan secara keseluruhan?'
        ]
      },
      {
        name: 'Visibility',
        description: 'Tampilan dan navigasi aplikasi',
        sort: 3,
        questions: [
          'Tampilan aplikasi?',
          'Kemudahan menu?',
          'Dashboard?',
          'Navigasi?',
          'Kerapian tampilan?'
        ]
      },
      {
        name: 'Cleanliness',
        description: 'Kestabilan dan pemeliharaan aplikasi',
        sort: 4,
        questions: [
          'Perbaikan bug?',
          'Kualitas update?',
          'Minim gangguan?',
          'Maintenance?',
          'Kesiapan aplikasi?'
        ]
      },
      {
        name: 'Add Value',
        description: 'Dampak positif aplikasi terhadap pekerjaan',
        sort: 5,
        questions: [
          'Membantu pekerjaan?',
          'Meningkatkan produktivitas?',
          'Mengurangi kesalahan?',
          'Mempermudah monitoring?',
          'Manfaat aplikasi?'
        ]
      }
    ];

    for (const cat of defaultCategories) {
      // Find or insert category
      const existingCat = await client.query('SELECT id FROM survey_categories WHERE name = $1', [cat.name]);
      let categoryId;
      if (existingCat.rows.length === 0) {
        const result = await client.query(
          'INSERT INTO survey_categories (name, description, sort_order) VALUES ($1, $2, $3) RETURNING id',
          [cat.name, cat.description, cat.sort]
        );
        categoryId = result.rows[0].id;
        console.log(`Category '${cat.name}' created with ID ${categoryId}.`);
      } else {
        categoryId = existingCat.rows[0].id;
        console.log(`Category '${cat.name}' already exists.`);
      }

      // Add default questions
      let qIndex = 1;
      for (const questionText of cat.questions) {
        const existingQ = await client.query(
          'SELECT id FROM survey_questions WHERE category_id = $1 AND question_text = $2',
          [categoryId, questionText]
        );
        if (existingQ.rows.length === 0) {
          await client.query(
            'INSERT INTO survey_questions (category_id, question_text, sort_order) VALUES ($1, $2, $3)',
            [categoryId, questionText, qIndex * 10]
          );
        }
        qIndex++;
      }
      console.log(`Questions for category '${cat.name}' verified/seeded.`);
    }

    console.log('Database setup completed successfully!');
  } catch (error) {
    console.error('Setup failed:', error);
    process.exit(1);
  } finally {
    if (client) {
      await client.end();
    }
  }
}

setup();
