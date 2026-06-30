// Check Authentication
const token = localStorage.getItem('adminToken');
const adminUser = JSON.parse(localStorage.getItem('adminUser') || '{}');

if (!token) {
  window.location.href = '/admin/login.html';
}

// Global Variables
let chartCategoryInstance = null;
let chartQuestionInstance = null;
let respondentsData = [];
let categoriesList = [];
let questionsList = [];
let cropperInstance = null;
let croppedBlob = null;

// Favicon updater helper
function updateFavicon(logoUrl) {
  if (!logoUrl) return;
  let link = document.querySelector("link[rel~='icon']");
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.getElementsByTagName('head')[0].appendChild(link);
  }
  link.href = logoUrl;
  if (logoUrl.endsWith('.svg')) link.type = 'image/svg+xml';
  else if (logoUrl.endsWith('.png')) link.type = 'image/png';
  else link.type = 'image/jpeg';
}

const loader = {
  show: (isTransparent = false) => {
    const el = document.getElementById('loadingOverlay');
    if (isTransparent) {
      el.classList.add('transparent-loading');
    } else {
      el.classList.remove('transparent-loading');
    }
    el.classList.add('active');
  },
  hide: () => {
    const el = document.getElementById('loadingOverlay');
    el.classList.remove('active');
    el.classList.remove('transparent-loading');
  }
};

// Headers with Authorization
const getHeaders = () => ({
  'Authorization': `Bearer ${token}`,
  'Content-Type': 'application/json'
});

// Init Dashboard
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('adminNameDisplay').textContent = adminUser.name || 'Administrator';

  // Set default filter dates (current month)
  const today = new Date();
  const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);

  document.getElementById('filterStartDate').value = formatDateISO(firstDay);
  document.getElementById('filterEndDate').value = formatDateISO(today);

  // Load configuration at startup for favicon/branding
  fetch('/api/survey/config')
    .then(res => res.json())
    .then(config => {
      if (config.logo_path) {
        updateFavicon(config.logo_path);
      }
    })
    .catch(err => console.error('Failed to load branding favicon:', err));

  // Initialize view
  switchTab('dashboard');
});

// Date formatting helpers
function formatDateISO(date) {
  return date.toISOString().split('T')[0];
}

function formatDateIndo(dateStr) {
  if (!dateStr) return '-';
  const options = { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  return new Date(dateStr).toLocaleDateString('id-ID', options);
}

// Log out handler
function handleLogout() {
  Swal.fire({
    title: 'Konfirmasi Keluar',
    text: 'Apakah Anda yakin ingin keluar dari halaman admin?',
    icon: 'question',
    showCancelButton: true,
    confirmButtonColor: '#ef4444',
    cancelButtonColor: '#64748b',
    confirmButtonText: 'Ya, Keluar',
    cancelButtonText: 'Batal'
  }).then((result) => {
    if (result.isConfirmed) {
      localStorage.removeItem('adminToken');
      localStorage.removeItem('adminUser');
      window.location.href = '/admin/login.html';
    }
  });
}

// Sidebar responsive toggle
function toggleSidebar() {
  document.getElementById('adminSidebar').classList.toggle('open');
}

// Tab Switching Route Controller
async function switchTab(tabId) {
  // Close mobile sidebar if open
  document.getElementById('adminSidebar').classList.remove('open');

  // Set active menu item styling
  const menuItems = document.querySelectorAll('.sidebar-menu .menu-item');
  menuItems.forEach(item => item.classList.remove('active'));
  document.getElementById(`tab-menu-${tabId}`).classList.add('active');

  // Set active tab content panel
  const tabContents = document.querySelectorAll('.tab-content');
  tabContents.forEach(content => content.classList.remove('active'));
  document.getElementById(`tab-${tabId}`).classList.add('active');

  // Load relevant tab data
  if (tabId === 'dashboard') {
    await loadDashboardData();
  } else if (tabId === 'categories') {
    await loadCategoriesData();
  } else if (tabId === 'questions') {
    await loadQuestionsData();
  } else if (tabId === 'settings') {
    await loadSettingsData();
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ========================================== 
// TAB 1: DASHBOARD RINGKASAN DATA
// ==========================================
async function loadDashboardData() {
  loader.show(true);
  const startDate = document.getElementById('filterStartDate').value;
  const endDate = document.getElementById('filterEndDate').value;

  try {
    // 1. Get statistics
    const statsUrl = `/api/admin/dashboard-stats?startDate=${startDate}&endDate=${endDate}`;
    const statsRes = await fetch(statsUrl, { headers: getHeaders() });
    if (!statsRes.ok) throw new Error('Gagal memuat statistik dashboard');
    const stats = await statsRes.json();

    // Populate stats
    document.getElementById('statTotalRespondents').textContent = stats.totalRespondents;
    document.getElementById('statAveragePercentage').textContent = `${stats.overallSatisfaction}%`;
    // Satisfaction index out of 5
    const satisfactionIndex = (stats.overallSatisfaction / 20).toFixed(2);
    document.getElementById('statSatisfactionIndex').textContent = `${satisfactionIndex} / 5.0`;

    // 2. Get charts data
    const chartsUrl = `/api/admin/charts?startDate=${startDate}&endDate=${endDate}`;
    const chartsRes = await fetch(chartsUrl, { headers: getHeaders() });
    const chartsData = await chartsRes.json();

    renderCategoryChart(chartsData.categories);
    renderQuestionChart(chartsData.questions);

    // 3. Get respondents list
    const respUrl = `/api/admin/respondents?startDate=${startDate}&endDate=${endDate}`;
    const respRes = await fetch(respUrl, { headers: getHeaders() });
    respondentsData = await respRes.json();

    populateRespondentsTable(respondentsData);

  } catch (error) {
    console.error('Error dashboard data:', error);
    Swal.fire({ icon: 'error', title: 'Error', text: error.message, confirmButtonColor: '#0f4c81' });
  } finally {
    loader.hide();
  }
}

// Apply date range filters
function applyFilters() {
  loadDashboardData();
}

// Render rating averages by category
function renderCategoryChart(data) {
  const ctx = document.getElementById('chartCategory').getContext('2d');

  if (chartCategoryInstance) {
    chartCategoryInstance.destroy();
  }

  const labels = data.map(d => d.name);
  const scores = data.map(d => parseFloat(d.avg_score));

  chartCategoryInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: 'Nilai Rata-Rata',
        data: scores,
        backgroundColor: 'rgba(15, 76, 129, 0.75)',
        borderColor: 'rgba(15, 76, 129, 1)',
        borderWidth: 2,
        borderRadius: 8,
        barThickness: 35
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          min: 0,
          max: 5,
          ticks: { stepSize: 1 }
        }
      },
      plugins: {
        legend: { display: false }
      }
    }
  });
}

// Render ratings per question
function renderQuestionChart(data) {
  const ctx = document.getElementById('chartQuestion').getContext('2d');

  if (chartQuestionInstance) {
    chartQuestionInstance.destroy();
  }

  const labels = data.map((d, index) => `P${index + 1}`);
  const scores = data.map(d => parseFloat(d.avg_score));
  const tooltips = data.map(d => `(${d.category}) ${d.question}`);

  chartQuestionInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Nilai',
        data: scores,
        backgroundColor: 'rgba(0, 180, 216, 0.2)',
        borderColor: 'rgba(0, 180, 216, 1)',
        borderWidth: 3,
        tension: 0.3,
        pointBackgroundColor: 'rgba(15, 76, 129, 1)',
        pointRadius: 5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          min: 0,
          max: 5,
          ticks: { stepSize: 1 }
        }
      },
      plugins: {
        tooltip: {
          callbacks: {
            title: (context) => {
              const idx = context[0].dataIndex;
              return labels[idx];
            },
            label: (context) => {
              const idx = context.dataIndex;
              return `${tooltips[idx]}: ${scores[idx]}`;
            }
          }
        },
        legend: { display: false }
      }
    }
  });
}

// Populate respondents list in data-table
function populateRespondentsTable(respondents) {
  const tbody = document.querySelector('#tableRespondents tbody');
  tbody.innerHTML = '';

  document.getElementById('respondentsCountLabel').textContent = `Menampilkan ${respondents.length} responden`;

  if (respondents.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--color-text-muted);">Tidak ada tanggapan responden ditemukan untuk filter ini.</td></tr>';
    return;
  }

  respondents.forEach(resp => {
    const tr = document.createElement('tr');

    const nama = resp.is_anonymous ? '<span class="badge badge-anon">Anonim</span>' : resp.name;
    const dept = resp.is_anonymous ? '<span class="badge badge-anon">Anonim</span>' : (resp.department || '-');
    const tgl = formatDateIndo(resp.submitted_at);

    let predClass = '';
    const predLower = resp.predicate.toLowerCase();
    if (predLower === 'sangat puas') predClass = 'predicate-sangat-puas';
    else if (predLower === 'puas') predClass = 'predicate-puas';
    else if (predLower === 'cukup puas') predClass = 'predicate-cukup-puas';
    else if (predLower === 'tidak puas') predClass = 'predicate-tidak-puas';
    else predClass = 'predicate-sangat-tidak-puas';

    tr.innerHTML = `
      <td>${tgl}</td>
      <td style="font-weight: 600;">${nama}</td>
      <td>${dept}</td>
      <td style="font-weight: 700;">${resp.total_score}</td>
      <td style="font-weight: 700;">${resp.percentage}%</td>
      <td><span class="badge ${predClass}">${resp.predicate}</span></td>
      <td>
        <div class="btn-action-group">
          <button type="button" class="btn-action btn-action-view" onclick="viewRespondentDetail(${resp.id})" title="Lihat Detail Tanggapan">
            <i class="fa-solid fa-eye"></i>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// Open detail scorecard for a respondent
function viewRespondentDetail(id) {
  const resp = respondentsData.find(r => r.id === id);
  if (!resp) return;

  document.getElementById('detailRespName').textContent = resp.is_anonymous ? 'Anonim' : resp.name;
  document.getElementById('detailRespDept').textContent = resp.is_anonymous ? 'Anonim' : (resp.department || '-');
  document.getElementById('detailRespTime').textContent = formatDateIndo(resp.submitted_at);
  document.getElementById('detailRespScore').textContent = resp.total_score;
  document.getElementById('detailRespPercent').textContent = `${resp.percentage}%`;

  const predEl = document.getElementById('detailRespPredicate');
  predEl.textContent = resp.predicate;
  predEl.className = 'badge';

  const predLower = resp.predicate.toLowerCase();
  if (predLower === 'sangat puas') predEl.classList.add('predicate-sangat-puas');
  else if (predLower === 'puas') predEl.classList.add('predicate-puas');
  else if (predLower === 'cukup puas') predEl.classList.add('predicate-cukup-puas');
  else if (predLower === 'tidak puas') predEl.classList.add('predicate-tidak-puas');
  else predEl.classList.add('predicate-sangat-tidak-puas');

  // Render answers grouped by category
  const answersDiv = document.getElementById('respondentDetailAnswers');
  answersDiv.innerHTML = '';

  // Group by category name
  const catGroups = {};
  resp.answers.forEach(ans => {
    if (!catGroups[ans.category_name]) {
      catGroups[ans.category_name] = [];
    }
    catGroups[ans.category_name].push(ans);
  });

  Object.entries(catGroups).forEach(([catName, qList]) => {
    const section = document.createElement('div');
    section.style.marginBottom = '1.25rem';

    let qItemsHtml = '';
    qList.forEach(q => {
      let answerDisplayHtml = '';
      if (q.question_type === 'text') {
        const textVal = q.text_value !== undefined && q.text_value !== null ? q.text_value : '-';
        answerDisplayHtml = `<span style="font-style: italic; color: var(--color-text-muted); font-size: 0.9rem; max-width: 60%; word-break: break-word; text-align: right;">"${textVal}"</span>`;
      } else {
        const rating = q.rating_value || 0;
        const starHtml = '<i class="fa-solid fa-star" style="color: var(--color-star-filled); margin-right: 2px;"></i>'.repeat(rating)
          + '<i class="fa-regular fa-star" style="color: var(--color-star-empty); margin-right: 2px;"></i>'.repeat(5 - rating);
        answerDisplayHtml = `
          <div style="display: flex; align-items: center; gap: 8px;">
            <div style="font-size: 0.9rem;">${starHtml}</div>
            <strong style="color: var(--color-primary-dark); font-size: 0.9rem;">(${rating})</strong>
          </div>
        `;
      }

      qItemsHtml += `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0; border-bottom: 1px dashed var(--color-border); gap: 10px;">
          <span style="font-size: 0.9rem; color: var(--color-text-main); max-width: 70%;">${q.question_text}</span>
          ${answerDisplayHtml}
        </div>
      `;
    });

    section.innerHTML = `
      <h5 style="background-color: var(--color-primary-light); color: var(--color-primary-dark); padding: 0.4rem 0.8rem; border-radius: 6px; font-weight: 700; margin-bottom: 0.5rem; font-size: 0.9rem;">
        Kategori: ${catName}
      </h5>
      <div style="padding-left: 0.5rem;">${qItemsHtml}</div>
    `;
    answersDiv.appendChild(section);
  });

  // Open Modal
  document.getElementById('modalRespondentDetail').classList.add('open');
}

function closeRespondentDetailModal() {
  document.getElementById('modalRespondentDetail').classList.remove('open');
}


// ==========================================
// TAB 2: MANAGE CATEGORIES
// ==========================================
async function loadCategoriesData() {
  loader.show();
  try {
    const res = await fetch('/api/admin/categories', { headers: getHeaders() });
    if (!res.ok) throw new Error('Gagal memuat kategori');
    categoriesList = await res.json();
    populateCategoriesTable(categoriesList);
  } catch (error) {
    Swal.fire({ icon: 'error', title: 'Error', text: error.message, confirmButtonColor: '#0f4c81' });
  } finally {
    loader.hide();
  }
}

function populateCategoriesTable(categories) {
  const tbody = document.querySelector('#tableCategories tbody');
  tbody.innerHTML = '';

  if (categories.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--color-text-muted);">Belum ada kategori survey.</td></tr>';
    return;
  }

  categories.forEach(cat => {
    const tr = document.createElement('tr');

    const activeBadge = cat.is_active
      ? '<span class="badge badge-active">Aktif</span>'
      : '<span class="badge badge-inactive">Tidak Aktif</span>';

    tr.innerHTML = `
      <td style="font-weight: 700; width: 80px;">${cat.sort_order}</td>
      <td style="font-weight: 600; font-size: 1rem; color: var(--color-primary-dark);">${cat.name}</td>
      <td style="color: var(--color-text-muted);">${cat.description || '-'}</td>
      <td>${activeBadge}</td>
      <td>
        <div class="btn-action-group">
          <button type="button" class="btn-action btn-action-edit" onclick="editCategory(${cat.id})" title="Edit Kategori">
            <i class="fa-solid fa-pen"></i>
          </button>
          <button type="button" class="btn-action btn-action-delete" onclick="deleteCategory(${cat.id})" title="Hapus Kategori">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function openCategoryModal() {
  document.getElementById('modalCategoryTitle').textContent = 'Tambah Kategori';
  document.getElementById('modalCategoryId').value = '';
  document.getElementById('catName').value = '';
  document.getElementById('catDescription').value = '';
  document.getElementById('catSortOrder').value = '0';
  document.getElementById('catIsActive').checked = true;
  document.getElementById('modalCategory').classList.add('open');
}

function closeCategoryModal() {
  document.getElementById('modalCategory').classList.remove('open');
}

async function editCategory(id) {
  const cat = categoriesList.find(c => c.id === id);
  if (!cat) return;

  document.getElementById('modalCategoryTitle').textContent = 'Edit Kategori';
  document.getElementById('modalCategoryId').value = cat.id;
  document.getElementById('catName').value = cat.name;
  document.getElementById('catDescription').value = cat.description || '';
  document.getElementById('catSortOrder').value = cat.sort_order;
  document.getElementById('catIsActive').checked = cat.is_active === 1;
  document.getElementById('modalCategory').classList.add('open');
}

async function saveCategory(e) {
  e.preventDefault();
  loader.show();

  const id = document.getElementById('modalCategoryId').value;
  const name = document.getElementById('catName').value.trim();
  const description = document.getElementById('catDescription').value.trim();
  const sort_order = parseInt(document.getElementById('catSortOrder').value) || 0;
  const is_active = document.getElementById('catIsActive').checked ? 1 : 0;

  const payload = { name, description, sort_order, is_active };
  const method = id ? 'PUT' : 'POST';
  const url = id ? `/api/admin/categories/${id}` : '/api/admin/categories';

  try {
    const res = await fetch(url, {
      method: method,
      headers: getHeaders(),
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal menyimpan kategori');

    closeCategoryModal();
    Swal.fire({ icon: 'success', title: 'Berhasil', text: 'Kategori berhasil disimpan!', timer: 1500, showConfirmButton: false });
    loadCategoriesData();
  } catch (error) {
    Swal.fire({ icon: 'error', title: 'Error', text: error.message, confirmButtonColor: '#ef4444' });
  } finally {
    loader.hide();
  }
}

async function deleteCategory(id) {
  Swal.fire({
    title: 'Hapus Kategori?',
    text: 'Menghapus kategori juga akan menghapus semua pertanyaan yang terkait dengan kategori ini. Tindakan ini tidak bisa dibatalkan!',
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#dc2626',
    cancelButtonColor: '#64748b',
    confirmButtonText: 'Ya, Hapus',
    cancelButtonText: 'Batal'
  }).then(async (result) => {
    if (result.isConfirmed) {
      loader.show();
      try {
        const res = await fetch(`/api/admin/categories/${id}`, {
          method: 'DELETE',
          headers: getHeaders()
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Gagal menghapus kategori');

        Swal.fire({ icon: 'success', title: 'Terhapus', text: 'Kategori berhasil dihapus.', timer: 1500, showConfirmButton: false });
        loadCategoriesData();
      } catch (error) {
        Swal.fire({ icon: 'error', title: 'Gagal', text: error.message, confirmButtonColor: '#ef4444' });
      } finally {
        loader.hide();
      }
    }
  });
}


// ==========================================
// TAB 3: MANAGE QUESTIONS
// ==========================================
async function loadQuestionsData() {
  loader.show();
  try {
    // We need both categories (for dropdown options) and questions
    const catRes = await fetch('/api/admin/categories', { headers: getHeaders() });
    categoriesList = await catRes.json();

    const qRes = await fetch('/api/admin/questions', { headers: getHeaders() });
    if (!qRes.ok) throw new Error('Gagal memuat pertanyaan');
    questionsList = await qRes.json();

    populateQuestionsTable(questionsList);
    populateCategoryDropdown(categoriesList);

  } catch (error) {
    Swal.fire({ icon: 'error', title: 'Error', text: error.message, confirmButtonColor: '#0f4c81' });
  } finally {
    loader.hide();
  }
}

function populateQuestionsTable(questions) {
  const tbody = document.querySelector('#tableQuestions tbody');
  tbody.innerHTML = '';

  if (questions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--color-text-muted);">Belum ada pertanyaan survey.</td></tr>';
    return;
  }

  questions.forEach(q => {
    const tr = document.createElement('tr');

    const activeBadge = q.is_active
      ? '<span class="badge badge-active">Aktif</span>'
      : '<span class="badge badge-inactive">Tidak Aktif</span>';

    const typeBadge = q.question_type === 'text'
      ? '<span class="badge" style="background-color: #e0f2fe; color: #0369a1;">Text</span>'
      : '<span class="badge" style="background-color: #fef3c7; color: #b45309;">Star</span>';

    const weightDisplay = q.question_type === 'text' ? '-' : q.weight;

    tr.innerHTML = `
      <td><span class="category-badge">${q.category_name}</span></td>
      <td style="font-weight: 700; width: 80px;">${q.sort_order}</td>
      <td style="font-weight: 600; color: var(--color-text-main); font-size: 0.95rem;">${q.question_text}</td>
      <td>${typeBadge}</td>
      <td style="font-weight: 700; width: 80px;">${weightDisplay}</td>
      <td>${activeBadge}</td>
      <td>
        <div class="btn-action-group">
          <button type="button" class="btn-action btn-action-edit" onclick="editQuestion(${q.id})" title="Edit Pertanyaan">
            <i class="fa-solid fa-pen"></i>
          </button>
          <button type="button" class="btn-action btn-action-delete" onclick="deleteQuestion(${q.id})" title="Hapus Pertanyaan">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function populateCategoryDropdown(categories) {
  const select = document.getElementById('qCategory');
  select.innerHTML = '<option value="" disabled selected>-- Pilih Kategori --</option>';

  categories.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    select.appendChild(opt);
  });
}

function toggleQuestionTypeFields() {
  const type = document.getElementById('qType').value;
  const weightGroup = document.getElementById('qWeightGroup');
  if (type === 'text') {
    weightGroup.style.display = 'none';
  } else {
    weightGroup.style.display = 'block';
  }
}

function openQuestionModal() {
  document.getElementById('modalQuestionTitle').textContent = 'Tambah Pertanyaan';
  document.getElementById('modalQuestionId').value = '';
  document.getElementById('qCategory').value = '';
  document.getElementById('qType').value = 'star';
  toggleQuestionTypeFields();
  document.getElementById('qText').value = '';
  document.getElementById('qSortOrder').value = '0';
  document.getElementById('qWeight').value = '1';
  document.getElementById('qIsActive').checked = true;
  document.getElementById('modalQuestion').classList.add('open');
}

function closeQuestionModal() {
  document.getElementById('modalQuestion').classList.remove('open');
}

function editQuestion(id) {
  const q = questionsList.find(item => item.id === id);
  if (!q) return;

  document.getElementById('modalQuestionTitle').textContent = 'Edit Pertanyaan';
  document.getElementById('modalQuestionId').value = q.id;
  document.getElementById('qCategory').value = q.category_id;
  document.getElementById('qType').value = q.question_type || 'star';
  toggleQuestionTypeFields();
  document.getElementById('qText').value = q.question_text;
  document.getElementById('qSortOrder').value = q.sort_order;
  document.getElementById('qWeight').value = q.weight;
  document.getElementById('qIsActive').checked = q.is_active === 1;
  document.getElementById('modalQuestion').classList.add('open');
}

async function saveQuestion(e) {
  e.preventDefault();
  loader.show();

  const id = document.getElementById('modalQuestionId').value;
  const category_id = document.getElementById('qCategory').value;
  const question_type = document.getElementById('qType').value;
  const question_text = document.getElementById('qText').value.trim();
  const sort_order = parseInt(document.getElementById('qSortOrder').value) || 0;
  const weight = parseInt(document.getElementById('qWeight').value) || 1;
  const is_active = document.getElementById('qIsActive').checked ? 1 : 0;

  const payload = { category_id, question_text, question_type, sort_order, is_active, weight };
  const method = id ? 'PUT' : 'POST';
  const url = id ? `/api/admin/questions/${id}` : '/api/admin/questions';

  try {
    const res = await fetch(url, {
      method: method,
      headers: getHeaders(),
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal menyimpan pertanyaan');

    closeQuestionModal();
    Swal.fire({ icon: 'success', title: 'Berhasil', text: 'Pertanyaan berhasil disimpan!', timer: 1500, showConfirmButton: false });
    loadQuestionsData();
  } catch (error) {
    Swal.fire({ icon: 'error', title: 'Error', text: error.message, confirmButtonColor: '#ef4444' });
  } finally {
    loader.hide();
  }
}

async function deleteQuestion(id) {
  Swal.fire({
    title: 'Hapus Pertanyaan?',
    text: 'Tindakan ini akan menghapus pertanyaan secara permanen dari database. Hasil survey yang telah masuk tidak akan terganggu, tetapi pertanyaan tidak akan tampil lagi di survey baru.',
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#dc2626',
    cancelButtonColor: '#64748b',
    confirmButtonText: 'Ya, Hapus',
    cancelButtonText: 'Batal'
  }).then(async (result) => {
    if (result.isConfirmed) {
      loader.show();
      try {
        const res = await fetch(`/api/admin/questions/${id}`, {
          method: 'DELETE',
          headers: getHeaders()
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Gagal menghapus pertanyaan');

        Swal.fire({ icon: 'success', title: 'Terhapus', text: 'Pertanyaan berhasil dihapus.', timer: 1500, showConfirmButton: false });
        loadQuestionsData();
      } catch (error) {
        Swal.fire({ icon: 'error', title: 'Gagal', text: error.message, confirmButtonColor: '#ef4444' });
      } finally {
        loader.hide();
      }
    }
  });
}


// ==========================================
// TAB 4: SYSTEM CONFIGURATION & BRANDING
// ==========================================
async function loadSettingsData() {
  loader.show();
  try {
    const res = await fetch('/api/survey/config');
    const config = await res.json();

    document.getElementById('settingSurveyTitle').value = config.survey_title || '';
    document.getElementById('settingWelcomeText').value = config.welcome_text || '';
    document.getElementById('settingShowIdentity').checked = config.show_identity !== '0';

    const logoPreview = document.getElementById('logoPreviewContainer');
    if (config.logo_path && config.logo_path.trim() !== '') {
      const logoWithBuster = `${config.logo_path}?t=${Date.now()}`;
      logoPreview.innerHTML = `<img src="${logoWithBuster}" alt="PT. BINA Logo">`;
      updateFavicon(logoWithBuster);
    } else {
      logoPreview.innerHTML = '<span style="color: var(--color-text-muted); font-size: 0.85rem;"><i class="fa-solid fa-images fa-lg"></i> No Logo Uploaded</span>';
    }

    // Reset logo upload input
    document.getElementById('logoFileInput').value = '';
    document.getElementById('btnSaveLogo').disabled = true;

  } catch (error) {
    Swal.fire({ icon: 'error', title: 'Gagal', text: 'Gagal memuat konfigurasi survey.', confirmButtonColor: '#ef4444' });
  } finally {
    loader.hide();
  }
}

async function saveGeneralSettings(e) {
  e.preventDefault();
  loader.show();

  const survey_title = document.getElementById('settingSurveyTitle').value.trim();
  const welcome_text = document.getElementById('settingWelcomeText').value.trim();
  const show_identity = document.getElementById('settingShowIdentity').checked ? '1' : '0';

  const payload = { survey_title, welcome_text, show_identity };

  try {
    const res = await fetch('/api/admin/settings', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal menyimpan settings');

    Swal.fire({ icon: 'success', title: 'Berhasil', text: 'Pengaturan umum berhasil disimpan!', timer: 1500, showConfirmButton: false });
    loadSettingsData();
  } catch (error) {
    Swal.fire({ icon: 'error', title: 'Error', text: error.message, confirmButtonColor: '#ef4444' });
  } finally {
    loader.hide();
  }
}

// Logo file picker changes with Cropper 1:1 modal trigger
function previewLogoFile(input) {
  const file = input.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    const cropImg = document.getElementById('cropImage');
    cropImg.src = e.target.result;

    document.getElementById('modalCrop').classList.add('open');

    // Destroy previous cropper instance if exists
    if (cropperInstance) {
      cropperInstance.destroy();
    }

    // Init cropper with 1:1 aspect ratio
    setTimeout(() => {
      cropperInstance = new Cropper(cropImg, {
        aspectRatio: 1,
        viewMode: 1,
        autoCropArea: 1,
        responsive: true,
        restore: false,
        checkCrossOrigin: false,
        guides: true,
        center: true,
        highlight: false,
        cropBoxMovable: true,
        cropBoxResizable: true,
        toggleDragModeOnDblclick: false,
      });
    }, 150);
  };
  reader.readAsDataURL(file);
}

// Close cropping modal and reset
function closeCropModal() {
  document.getElementById('modalCrop').classList.remove('open');
  if (cropperInstance) {
    cropperInstance.destroy();
    cropperInstance = null;
  }
  document.getElementById('logoFileInput').value = '';
}

// Crop and generate 1:1 blob
function applyCrop() {
  if (!cropperInstance) return;

  const canvas = cropperInstance.getCroppedCanvas({
    width: 300,
    height: 300
  });

  const logoPreview = document.getElementById('logoPreviewContainer');
  logoPreview.innerHTML = `<img src="${canvas.toDataURL('image/jpeg')}" alt="Preview Logo">`;

  document.getElementById('btnSaveLogo').disabled = false;

  canvas.toBlob((blob) => {
    croppedBlob = blob;
  }, 'image/jpeg', 0.9);

  document.getElementById('modalCrop').classList.remove('open');
  if (cropperInstance) {
    cropperInstance.destroy();
    cropperInstance = null;
  }
}

// Logo upload form submission (sends cropped 1:1 blob)
async function handleLogoUpload(e) {
  e.preventDefault();
  if (!croppedBlob) {
    Swal.fire({ icon: 'warning', title: 'Belum Dipotong', text: 'Silakan pilih dan potong gambar terlebih dahulu.', confirmButtonColor: '#ef4444' });
    return;
  }

  loader.show();
  const formData = new FormData();
  // Upload blob renamed as bina.jpg to match bucket config
  formData.append('logo', croppedBlob, 'bina.jpg');

  try {
    const res = await fetch('/api/admin/settings/logo', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`
      },
      body: formData
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal mengunggah logo');

    Swal.fire({ icon: 'success', title: 'Berhasil', text: 'Logo perusahaan berhasil diperbarui!', timer: 1500, showConfirmButton: false });

    // Clear croppedBlob after successful upload
    croppedBlob = null;
    loadSettingsData();
  } catch (error) {
    Swal.fire({ icon: 'error', title: 'Upload Gagal', text: error.message, confirmButtonColor: '#ef4444' });
  } finally {
    loader.hide();
  }
}

// Reset logo to standard default branding
async function resetBrandingLogo() {
  Swal.fire({
    title: 'Hapus Logo?',
    text: 'Logo akan dikembalikan ke ikon default sistem PT. BINA.',
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#dc2626',
    cancelButtonColor: '#64748b',
    confirmButtonText: 'Ya, Hapus',
    cancelButtonText: 'Batal'
  }).then(async (result) => {
    if (result.isConfirmed) {
      loader.show();
      try {
        const res = await fetch('/api/admin/settings/logo', {
          method: 'DELETE',
          headers: getHeaders()
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Gagal menghapus logo');

        Swal.fire({ icon: 'success', title: 'Berhasil', text: 'Logo berhasil dihapus.', timer: 1500, showConfirmButton: false });
        loadSettingsData();
      } catch (error) {
        Swal.fire({ icon: 'error', title: 'Gagal', text: error.message, confirmButtonColor: '#ef4444' });
      } finally {
        loader.hide();
      }
    }
  });
}


// ==========================================
// 7. EXPORT DATA: EXCEL AND PDF
// ==========================================

// Excel Export function using SheetJS
function exportExcel() {
  if (respondentsData.length === 0) {
    Swal.fire({ icon: 'warning', title: 'Tabel Kosong', text: 'Tidak ada data responden untuk diekspor.', confirmButtonColor: '#0f4c81' });
    return;
  }

  try {
    // Generate headers. We need fixed details plus every question as a column
    // Get unique list of questions
    const questionHeaders = [];
    const questionIds = [];

    // Scan respondents answers to collect questions headers
    respondentsData.forEach(resp => {
      resp.answers.forEach(ans => {
        if (!questionIds.includes(ans.question_id)) {
          questionIds.push(ans.question_id);
          questionHeaders.push(`(${ans.category_name}) ${ans.question_text}`);
        }
      });
    });

    const worksheetData = [];

    // Add file headers
    const excelHeaders = ['ID', 'Waktu Masuk', 'Nama Responden', 'Departemen', 'Status Anonim', 'Total Skor', 'Persentase', 'Predikat', ...questionHeaders];
    worksheetData.push(excelHeaders);

    // Add rows
    respondentsData.forEach(resp => {
      const row = [
        resp.id,
        formatDateIndo(resp.submitted_at),
        resp.is_anonymous ? 'Anonim' : resp.name,
        resp.is_anonymous ? 'Anonim' : (resp.department || '-'),
        resp.is_anonymous ? 'Ya' : 'Tidak',
        resp.total_score,
        `${resp.percentage}%`,
        resp.predicate
      ];

      // Add rating score or text matching questionIds order
      questionIds.forEach(qId => {
        const answer = resp.answers.find(ans => ans.question_id === qId);
        if (answer) {
          row.push(answer.question_type === 'text' ? (answer.text_value || '') : answer.rating_value);
        } else {
          row.push('-');
        }
      });

      worksheetData.push(row);
    });

    // Create Excel Workbook
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(worksheetData);
    XLSX.utils.book_append_sheet(wb, ws, "Hasil Survey CSS");

    // Download
    const filename = `PT_BINA_Survey_CSS_${new Date().toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(wb, filename);

    Swal.fire({ icon: 'success', title: 'Berhasil Ekspor', text: 'File Excel berhasil diunduh.', timer: 1500, showConfirmButton: false });
  } catch (error) {
    console.error('Excel Export Error:', error);
    Swal.fire({ icon: 'error', title: 'Ekspor Gagal', text: 'Terjadi kesalahan saat mengekspor data Excel.', confirmButtonColor: '#ef4444' });
  }
}

// PDF Export function using html2pdf.js
function exportPDF() {
  loader.show();

  // Create clean printable view
  const element = document.getElementById('pdfReportContent');

  // Update PDF only layout banner
  const pdfHeader = document.getElementById('pdfHeaderBrand');
  pdfHeader.style.display = 'block';

  // Inject logo if set
  const logoImg = document.querySelector('#logoPreviewContainer img');
  const pdfLogoContainer = document.getElementById('pdfHeaderLogoContainer');
  if (logoImg) {
    pdfLogoContainer.innerHTML = `<img src="${logoImg.src}" style="height: 45px; object-fit: contain;">`;
  } else {
    pdfLogoContainer.innerHTML = '<span style="font-weight: 700; color: #0f4c81;">PT. BINA</span>';
  }

  // Prepend statistics recap inside the pdf container
  const statsRecap = document.createElement('div');
  statsRecap.id = 'pdfStatsRecap';
  statsRecap.style.display = 'grid';
  statsRecap.style.gridTemplateColumns = 'repeat(3, 1fr)';
  statsRecap.style.gap = '1rem';
  statsRecap.style.marginBottom = '2.5rem';
  statsRecap.innerHTML = `
    <div style="border: 1px solid #cbd5e1; padding: 1rem; border-radius: 8px; text-align: center; background-color: #f8fafc;">
      <div style="font-size: 0.75rem; font-weight: 700; color: #64748b; text-transform: uppercase;">Total Responden</div>
      <div style="font-size: 1.5rem; font-weight: 800; color: #0f172a; margin-top: 0.25rem;">${document.getElementById('statTotalRespondents').textContent}</div>
    </div>
    <div style="border: 1px solid #cbd5e1; padding: 1rem; border-radius: 8px; text-align: center; background-color: #f8fafc;">
      <div style="font-size: 0.75rem; font-weight: 700; color: #64748b; text-transform: uppercase;">Rata-Rata Persentase</div>
      <div style="font-size: 1.5rem; font-weight: 800; color: #0f172a; margin-top: 0.25rem;">${document.getElementById('statAveragePercentage').textContent}</div>
    </div>
    <div style="border: 1px solid #cbd5e1; padding: 1rem; border-radius: 8px; text-align: center; background-color: #f8fafc;">
      <div style="font-size: 0.75rem; font-weight: 700; color: #64748b; text-transform: uppercase;">Indeks Kepuasan</div>
      <div style="font-size: 1.5rem; font-weight: 800; color: #0f172a; margin-top: 0.25rem;">${document.getElementById('statSatisfactionIndex').textContent}</div>
    </div>
  `;
  element.insertBefore(statsRecap, element.children[1]); // Insert after pdfHeader

  // Add date filters to pdfHeader description
  const startDate = document.getElementById('filterStartDate').value;
  const endDate = document.getElementById('filterEndDate').value;
  const dateInfo = document.createElement('p');
  dateInfo.id = 'pdfDateRangeInfo';
  dateInfo.style.fontSize = '0.85rem';
  dateInfo.style.color = '#475569';
  dateInfo.style.marginTop = '0.5rem';
  dateInfo.innerHTML = `Periode Survey: <strong>${formatDateIndo(startDate)}</strong> s.d. <strong>${formatDateIndo(endDate)}</strong>`;
  pdfHeader.appendChild(dateInfo);

  const opt = {
    margin: [0.5, 0.5, 0.5, 0.5],
    filename: `Laporan_PT_BINA_Survey_CSS_${new Date().toISOString().slice(0, 10)}.pdf`,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true },
    jsPDF: { unit: 'in', format: 'letter', orientation: 'landscape' }
  };

  // Run generation
  html2pdf().set(opt).from(element).save().then(() => {
    // Revert layout styles
    pdfHeader.style.display = 'none';
    const recap = document.getElementById('pdfStatsRecap');
    if (recap) recap.remove();
    const dateRange = document.getElementById('pdfDateRangeInfo');
    if (dateRange) dateRange.remove();
    loader.hide();
    Swal.fire({ icon: 'success', title: 'Berhasil Cetak', text: 'Laporan PDF berhasil diunduh.', timer: 1500, showConfirmButton: false });
  }).catch(err => {
    console.error('PDF generation error:', err);
    pdfHeader.style.display = 'none';
    const recap = document.getElementById('pdfStatsRecap');
    if (recap) recap.remove();
    const dateRange = document.getElementById('pdfDateRangeInfo');
    if (dateRange) dateRange.remove();
    loader.hide();
    Swal.fire({ icon: 'error', title: 'Cetak Gagal', text: 'Gagal membuat file PDF.', confirmButtonColor: '#ef4444' });
  });
}
