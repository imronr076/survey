// Survey State
let configData = {};
let surveyCategories = [];
let responses = {}; // Key: questionId, Value: rating
let currentCategoryIndex = 0;
let isIdentityEnabled = true; // From settings: show_identity
let wantsIdentity = null; // null, true, or false

// Favicon updater helper with cache-busting timestamp support
function updateFavicon(logoUrl) {
  if (!logoUrl) return;
  const urlWithBuster = logoUrl.includes('?t=') ? logoUrl : `${logoUrl}?t=${Date.now()}`;
  let link = document.querySelector("link[rel~='icon']");
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.getElementsByTagName('head')[0].appendChild(link);
  }
  link.href = urlWithBuster;
  if (logoUrl.endsWith('.svg') || logoUrl.includes('.svg?')) link.type = 'image/svg+xml';
  else if (logoUrl.endsWith('.png') || logoUrl.includes('.png?')) link.type = 'image/png';
  else link.type = 'image/jpeg';
}

// Loader utility
const loader = {
  show: () => document.getElementById('loadingOverlay').classList.add('active'),
  hide: () => document.getElementById('loadingOverlay').classList.remove('active')
};

// Initializer
document.addEventListener('DOMContentLoaded', () => {
  initSurvey();
});

// Load configuration and prepare page
async function initSurvey() {
  loader.show();
  try {
    // 1. Fetch survey title, welcome text, identity settings, logo
    const configRes = await fetch('/api/survey/config');
    if (!configRes.ok) throw new Error('Gagal memuat konfigurasi survey');
    configData = await configRes.json();

    // 2. Apply branding & text from settings
    if (configData.survey_title) {
      document.title = configData.survey_title;
      document.getElementById('surveyTitle').textContent = configData.survey_title;
    }
    if (configData.welcome_text) {
      document.getElementById('welcomeText').textContent = configData.welcome_text;
    }
    if (configData.logo_path) {
      const logoWithBuster = `${configData.logo_path}?t=${Date.now()}`;
      document.getElementById('surveyLogoContainer').innerHTML = `
        <img src="${logoWithBuster}" alt="PT. BINA Logo" class="brand-logo">
      `;
      updateFavicon(logoWithBuster);
    }

    isIdentityEnabled = configData.show_identity !== '0';
    if (!isIdentityEnabled) {
      wantsIdentity = false; // Forced anonymous
    }

    // 3. Load active categories and questions
    const questionsRes = await fetch('/api/survey/questions');
    if (!questionsRes.ok) throw new Error('Gagal memuat data pertanyaan');
    surveyCategories = await questionsRes.json();

    if (surveyCategories.length === 0) {
      Swal.fire({
        icon: 'warning',
        title: 'Survey Kosong',
        text: 'Maaf, tidak ada pertanyaan survey yang aktif saat ini. Silakan hubungi admin.',
        confirmButtonColor: '#0f4c81'
      });
    }

  } catch (error) {
    console.error('Error initializing survey:', error);
    Swal.fire({
      icon: 'error',
      title: 'Koneksi Gagal',
      text: 'Gagal terhubung dengan server survey.',
      confirmButtonColor: '#0f4c81'
    });
  } finally {
    loader.hide();
  }
}

// Separate welcome card transitions
function goToNextStep() {
  if (isIdentityEnabled) {
    document.getElementById('stepWelcome').style.display = 'none';
    document.getElementById('stepIdentity').style.display = 'block';
  } else {
    // Skip identity selection, go straight to questions wizard
    document.getElementById('stepWelcome').style.display = 'none';
    document.getElementById('stepSurvey').style.display = 'block';
    
    currentCategoryIndex = 0;
    renderActiveCategory();
    updateProgressBar();
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function goBackToWelcome() {
  document.getElementById('stepIdentity').style.display = 'none';
  document.getElementById('stepWelcome').style.display = 'block';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Handle Identity Selection (Ya/Tidak)
function selectIdentityChoice(wants) {
  wantsIdentity = wants;
  
  const btnYes = document.getElementById('btnAnonNo');
  const btnNo = document.getElementById('btnAnonYes');
  const formContainer = document.getElementById('identityFormContainer');

  if (wants) {
    btnYes.classList.add('selected');
    btnNo.classList.remove('selected');
    formContainer.classList.add('show');
  } else {
    btnYes.classList.remove('selected');
    btnNo.classList.add('selected');
    formContainer.classList.remove('show');
    // Reset values
    document.getElementById('respName').value = '';
    document.getElementById('respDept').value = '';
  }
}

// Start Survey Wizard (transition from Step 2 to Step 3)
function startSurveyWizard() {
  if (isIdentityEnabled && wantsIdentity === null) {
    Swal.fire({
      icon: 'info',
      title: 'Perhatian',
      text: 'Silakan pilih apakah Anda bersedia mengisi identitas lengkap atau tidak.',
      confirmButtonColor: '#0f4c81'
    });
    return;
  }

  // Validate identity if "Ya" selected
  if (isIdentityEnabled && wantsIdentity === true) {
    const name = document.getElementById('respName').value.trim();
    const dept = document.getElementById('respDept').value.trim();

    if (!name || !dept) {
      Swal.fire({
        icon: 'warning',
        title: 'Formulir Belum Lengkap',
        text: 'Nama Lengkap dan Departemen wajib diisi jika Anda bersedia mengisi identitas.',
        confirmButtonColor: '#0f4c81'
      });
      return;
    }
  }

  // Show survey wizard layout
  document.getElementById('stepIdentity').style.display = 'none';
  document.getElementById('stepSurvey').style.display = 'block';

  currentCategoryIndex = 0;
  renderActiveCategory();
  updateProgressBar();
}

// Render the current category questions
function renderActiveCategory() {
  const container = document.getElementById('surveyQuestionsContainer');
  container.innerHTML = '';

  if (surveyCategories.length === 0) return;

  const category = surveyCategories[currentCategoryIndex];
  
  // Update header text
  document.getElementById('wizardStepIndicator').textContent = `Kategori ${currentCategoryIndex + 1} dari ${surveyCategories.length}`;
  document.getElementById('wizardCategoryBadge').textContent = category.name;

  // Render back button visibility
  document.getElementById('btnPrevCategory').style.visibility = 'visible';
  
  // Render next button label (Next vs Submit)
  const isLast = currentCategoryIndex === surveyCategories.length - 1;
  document.getElementById('btnNextCategory').innerHTML = isLast 
    ? 'Kirim Survey <i class="fa-solid fa-paper-plane"></i>' 
    : 'Lanjut <i class="fa-solid fa-arrow-right"></i>';
  if (isLast) {
    document.getElementById('btnNextCategory').style.backgroundColor = '#10b981';
  } else {
    document.getElementById('btnNextCategory').style.backgroundColor = 'var(--color-primary)';
  }

  // Render each question
  category.questions.forEach((q) => {
    const questionEl = document.createElement('div');
    questionEl.className = 'question-item';

    if (q.question_type === 'text') {
      const textValue = responses[q.id] || '';
      questionEl.innerHTML = `
        <div class="question-text">${q.question_text}</div>
        <div class="text-response" style="margin-top: 0.5rem; margin-bottom: 0.5rem;">
          <textarea class="form-control" placeholder="Tulis masukan atau jawaban Anda di sini (opsional)..." rows="3" style="resize: vertical;" oninput="handleTextChange(${q.id}, this.value)">${textValue}</textarea>
        </div>
      `;
    } else {
      const selectedRating = responses[q.id] || 0;
      questionEl.innerHTML = `
        <div class="question-text">${q.question_text}</div>
        <div class="star-rating">
          <input type="radio" id="q${q.id}_star5" name="q${q.id}" value="5" ${selectedRating === 5 ? 'checked' : ''} onchange="handleRatingChange(${q.id}, 5)">
          <label for="q${q.id}_star5" title="Sangat Puas"><i class="fa-solid fa-star"></i></label>
          
          <input type="radio" id="q${q.id}_star4" name="q${q.id}" value="4" ${selectedRating === 4 ? 'checked' : ''} onchange="handleRatingChange(${q.id}, 4)">
          <label for="q${q.id}_star4" title="Puas"><i class="fa-solid fa-star"></i></label>
          
          <input type="radio" id="q${q.id}_star3" name="q${q.id}" value="3" ${selectedRating === 3 ? 'checked' : ''} onchange="handleRatingChange(${q.id}, 3)">
          <label for="q${q.id}_star3" title="Cukup Puas"><i class="fa-solid fa-star"></i></label>
          
          <input type="radio" id="q${q.id}_star2" name="q${q.id}" value="2" ${selectedRating === 2 ? 'checked' : ''} onchange="handleRatingChange(${q.id}, 2)">
          <label for="q${q.id}_star2" title="Tidak Puas"><i class="fa-solid fa-star"></i></label>
          
          <input type="radio" id="q${q.id}_star1" name="q${q.id}" value="1" ${selectedRating === 1 ? 'checked' : ''} onchange="handleRatingChange(${q.id}, 1)">
          <label for="q${q.id}_star1" title="Sangat Tidak Puas"><i class="fa-solid fa-star"></i></label>
        </div>
      `;
    }
    container.appendChild(questionEl);
  });
}

// Track rating changes
function handleRatingChange(questionId, value) {
  responses[questionId] = value;
  updateProgressBar();
}

// Track text response changes
function handleTextChange(questionId, value) {
  responses[questionId] = value;
  updateProgressBar();
}

// Calculate and update the UI progress bar
function updateProgressBar() {
  let totalQuestions = 0;
  surveyCategories.forEach(c => {
    totalQuestions += c.questions.length;
  });

  if (totalQuestions === 0) return;

  let answeredCount = 0;
  Object.entries(responses).forEach(([qId, val]) => {
    if (val !== undefined && val !== null && val !== '') {
      answeredCount++;
    }
  });

  const progressPercent = Math.min(100, Math.round((answeredCount / totalQuestions) * 100));

  const progressBar = document.getElementById('wizardProgressBar');
  progressBar.style.width = `${progressPercent}%`;
}

// Check if all questions in the current category are filled (text questions are optional)
function validateCurrentCategory() {
  const currentCategory = surveyCategories[currentCategoryIndex];
  const missing = [];

  currentCategory.questions.forEach(q => {
    if (q.question_type !== 'text') {
      if (!responses[q.id]) {
        missing.push(q.question_text);
      }
    }
  });

  return missing;
}

// Go to next category or submit
async function nextCategory() {
  // Validate current category is filled
  const missing = validateCurrentCategory();
  if (missing.length > 0) {
    Swal.fire({
      icon: 'warning',
      title: 'Pertanyaan Wajib Diisi',
      text: 'Harap isi semua penilaian bintang sebelum melanjutkan.',
      confirmButtonColor: '#0f4c81'
    });
    return;
  }

  // If last category, trigger submit
  if (currentCategoryIndex === surveyCategories.length - 1) {
    submitSurvey();
  } else {
    // Slide to next category
    currentCategoryIndex++;
    renderActiveCategory();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

// Go to previous category
function prevCategory() {
  if (currentCategoryIndex > 0) {
    currentCategoryIndex--;
    renderActiveCategory();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else {
    // Go back to identity page or welcome page
    document.getElementById('stepSurvey').style.display = 'none';
    if (isIdentityEnabled) {
      document.getElementById('stepIdentity').style.display = 'block';
    } else {
      document.getElementById('stepWelcome').style.display = 'block';
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

// Submit final response
async function submitSurvey() {
  loader.show();

  const isAnon = wantsIdentity === false;
  const name = isAnon ? '' : document.getElementById('respName').value.trim();
  const dept = isAnon ? '' : document.getElementById('respDept').value.trim();

  // Map answers array (including all questions in categories)
  const formattedAnswers = [];
  surveyCategories.forEach(cat => {
    cat.questions.forEach(q => {
      const val = responses[q.id];
      if (q.question_type === 'text') {
        formattedAnswers.push({
          question_id: q.id,
          rating_value: null,
          text_value: (val !== undefined && val !== null && val !== '') ? String(val) : null
        });
      } else {
        formattedAnswers.push({
          question_id: q.id,
          rating_value: val ? parseInt(val) : null,
          text_value: null
        });
      }
    });
  });

  const payload = {
    is_anonymous: isAnon,
    name: name || null,
    department: dept || null,
    answers: formattedAnswers
  };

  try {
    const res = await fetch('/api/survey/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal mengirim survey');

    // Transition to results display
    showResults(data);
  } catch (error) {
    console.error('Error submitting survey:', error);
    Swal.fire({
      icon: 'error',
      title: 'Terjadi Kesalahan',
      text: error.message || 'Gagal mengirimkan survey Anda. Silakan coba lagi.',
      confirmButtonColor: '#0f4c81'
    });
  } finally {
    loader.hide();
  }
}

// Show results page
function showResults(data) {
  document.getElementById('stepSurvey').style.display = 'none';
  document.getElementById('stepResults').style.display = 'block';
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Update elements
  document.getElementById('resultScore').textContent = data.totalScore;
  document.getElementById('resultPercentage').textContent = `${data.percentage}%`;
  
  // Set Predicate and apply appropriate CSS class
  const predEl = document.getElementById('resultPredicate');
  predEl.textContent = data.predicate;
  
  // Reset classes
  predEl.className = 'predicate-display';
  
  // Map predicate to styling classes & calculate rating stars
  let starsHtml = '';
  const predLower = data.predicate.toLowerCase();
  
  if (predLower === 'sangat puas') {
    predEl.classList.add('predicate-sangat-puas');
    starsHtml = '<i class="fa-solid fa-star"></i>'.repeat(5);
  } else if (predLower === 'puas') {
    predEl.classList.add('predicate-puas');
    starsHtml = '<i class="fa-solid fa-star"></i>'.repeat(4) + '<i class="fa-regular fa-star"></i>';
  } else if (predLower === 'cukup puas') {
    predEl.classList.add('predicate-cukup-puas');
    starsHtml = '<i class="fa-solid fa-star"></i>'.repeat(3) + '<i class="fa-regular fa-star"></i>'.repeat(2);
  } else if (predLower === 'tidak puas') {
    predEl.classList.add('predicate-tidak-puas');
    starsHtml = '<i class="fa-solid fa-star"></i>'.repeat(2) + '<i class="fa-regular fa-star"></i>'.repeat(3);
  } else {
    predEl.classList.add('predicate-sangat-tidak-puas');
    starsHtml = '<i class="fa-solid fa-star"></i>' + '<i class="fa-regular fa-star"></i>'.repeat(4);
  }

  document.getElementById('resultStars').innerHTML = starsHtml;

  Swal.fire({
    icon: 'success',
    title: 'Terima Kasih!',
    text: 'Survey Anda berhasil terkirim. Kami sangat menghargai partisipasi Anda!',
    confirmButtonColor: '#10b981'
  });
}

// Reset and restart survey
function resetSurvey() {
  responses = {};
  wantsIdentity = null;
  currentCategoryIndex = 0;

  // Clear fields
  document.getElementById('respName').value = '';
  document.getElementById('respDept').value = '';

  // Reset Identity Toggles styling
  document.getElementById('btnAnonNo').classList.remove('selected');
  document.getElementById('btnAnonYes').classList.remove('selected');
  document.getElementById('identityFormContainer').classList.remove('show');

  // Go to step 1
  document.getElementById('stepResults').style.display = 'none';
  document.getElementById('stepIdentity').style.display = 'none';
  document.getElementById('stepSurvey').style.display = 'none';
  document.getElementById('stepWelcome').style.display = 'block';
  
  if (!isIdentityEnabled) {
    wantsIdentity = false;
  }
}
