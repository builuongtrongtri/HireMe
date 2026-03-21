const API_BASE_URL = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    ? 'http://localhost:3000/api'
    : 'https://hireme-dtdx.onrender.com/api';
const AUTH_TOKEN_KEY = 'hireme_token';
const PENDING_EXPERT_KEY = 'hireme_selected_expert';

let authToken = localStorage.getItem(AUTH_TOKEN_KEY) || '';
let isLoggedIn = false;
let currentUser = '';
let uploadedFileName = '';
let uploadedFile = null;
let selectedDate = '';
let selectedTime = '';
let authUser = null;
let authMode = 'login';

document.addEventListener('DOMContentLoaded', async () => {
    const currentFile = window.location.pathname.split('/').pop() || 'index.html';
    if (currentFile !== 'index.html') {
        const pageFromFile = inferPageIdFromRoute(currentFile);
        window.location.replace(urlForPage(pageFromFile));
        return;
    }

    document.body.style.visibility = 'hidden';

    const requestedPage = currentPageFromUrl();
    if (requestedPage === 'landing') {
        await initPageState();
    } else {
        await loadPageWithoutReload(pageRoute(requestedPage), false, requestedPage);
    }

    document.body.style.visibility = '';

    window.addEventListener('popstate', async () => {
        const pageId = currentPageFromUrl();
        await loadPageWithoutReload(pageRoute(pageId), false, pageId);
    });
});

function pageRoute(pageId) {
    return {
        landing: 'index.html',
        booking: 'booking.html',
        experts: 'experts.html',
        history: 'history.html'
    }[pageId] || 'index.html';
}

function inferPageIdFromRoute(route) {
    const file = String(route || '').split('/').pop();
    const map = {
        'index.html': 'landing',
        'booking.html': 'booking',
        'experts.html': 'experts',
        'history.html': 'history'
    };
    return map[file] || 'landing';
}

function urlForPage(pageId) {
    if (pageId === 'landing') return 'index.html';
    return `index.html?page=${pageId}`;
}

function currentPageFromUrl() {
    const page = new URLSearchParams(window.location.search).get('page');
    if (page && ['landing', 'booking', 'experts', 'history'].includes(page)) {
        return page;
    }
    return 'landing';
}

async function loadPageWithoutReload(route, pushState = true, pageId = inferPageIdFromRoute(route)) {
    const header = document.getElementById('main-header');
    if (!header) {
        window.location.href = route;
        return;
    }

    try {
        const response = await fetch(route, { method: 'GET' });
        if (!response.ok) throw new Error('Cannot load page');
        const html = await response.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');

        const incomingChildren = Array.from(doc.body.children).filter((node) => {
            if (node.id === 'main-header') return false;
            if (node.tagName === 'SCRIPT' && node.getAttribute('src')?.includes('scripts/app.js')) return false;
            return true;
        });

        Array.from(document.body.children).forEach((node) => {
            if (node.id !== 'main-header') node.remove();
        });

        document.body.dataset.page = pageId || doc.body.dataset.page || inferPageIdFromRoute(route);
        incomingChildren.forEach((node) => document.body.appendChild(node.cloneNode(true)));

        if (pushState) {
            history.pushState({ route, pageId }, '', urlForPage(pageId));
        }

        await initPageState();
    } catch (_error) {
        // Fallback to hard navigation if dynamic load fails
        window.location.href = route;
    }
}

function navigate(pageId) {
    const route = pageRoute(pageId);
    const current = currentPageFromUrl();
    if (current === pageId && document.body?.dataset?.page === pageId) return;
    loadPageWithoutReload(route, true, pageId);
}

async function initPageState() {
    markActiveNav();

    const dateInput = document.getElementById('booking-date');
    if (dateInput) {
        dateInput.setAttribute('min', new Date().toISOString().split('T')[0]);
    }

    await hydrateAuthFromToken();
    await loadExpertsFromApi();
    applyPendingExpertSelection();
}

function markActiveNav() {
    const page = document.body?.dataset?.page;
    if (!page) return;
    document.querySelectorAll('.nav-links li').forEach((item) => item.classList.remove('active'));
    const nav = document.getElementById(`nav-${page}`);
    if (nav) nav.classList.add('active');
}

function openModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'flex';
}

function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
}

function setAuthUI(loggedIn, displayName = '') {
    const authButtons = document.getElementById('auth-buttons');
    const userProfile = document.getElementById('user-profile');
    const username = document.getElementById('display-username');

    if (authButtons) authButtons.style.display = loggedIn ? 'none' : 'block';
    if (userProfile) userProfile.style.display = loggedIn ? 'flex' : 'none';
    if (loggedIn && username) username.innerText = displayName;
}

async function apiFetch(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (!(options.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
    }
    if (authToken) {
        headers.Authorization = `Bearer ${authToken}`;
    }

    const response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.message || 'Có lỗi xảy ra khi gọi API.');
    }
    return data;
}

async function hydrateAuthFromToken() {
    if (!authToken) {
        setAuthUI(false);
        return;
    }

    try {
        const me = await apiFetch('/auth/me');
        authUser = me.user;
        currentUser = authUser.fullName;
        isLoggedIn = true;
        setAuthUI(true, currentUser);
        await loadHistoryFromApi();
    } catch (_error) {
        authToken = '';
        localStorage.removeItem(AUTH_TOKEN_KEY);
        isLoggedIn = false;
        authUser = null;
        setAuthUI(false);
    }
}

async function loadExpertsFromApi() {
    const select = document.getElementById('expert-select');
    const grid = document.getElementById('experts-grid');
    if (!select && !grid) return;

    try {
        const response = await apiFetch('/experts', { method: 'GET' });
        const experts = response.experts || [];

        if (select) {
            select.innerHTML = '<option value="150000" data-expert-id="">Hệ thống phân công ngẫu nhiên - 150.000đ</option>';
            experts.forEach((expert) => {
                const option = document.createElement('option');
                option.value = String(expert.priceVnd);
                option.dataset.expertId = expert.id;
                option.dataset.expertName = expert.fullName;
                option.textContent = `${expert.fullName} (${Number(expert.priceVnd).toLocaleString('vi-VN')}đ)`;
                select.appendChild(option);
            });
            updatePrice();
        }

        if (grid) {
            renderExpertsGrid(experts);
        }
    } catch (error) {
        if (grid) {
            grid.innerHTML = '<div class="card" style="text-align:center;color:#64748b;">Không tải được danh sách chuyên gia.</div>';
        }
        console.warn('Expert load error:', error.message);
    }
}

function renderExpertsGrid(experts) {
    const grid = document.getElementById('experts-grid');
    if (!grid) return;

    if (!experts.length) {
        grid.innerHTML = '<div class="card" style="text-align:center;color:#64748b;">Hiện chưa có chuyên gia khả dụng.</div>';
        return;
    }

    grid.innerHTML = experts.map((expert) => {
        const avatar = (expert.fullName || 'C').charAt(0).toUpperCase();
        const safeName = (expert.fullName || 'Chuyên gia').replace(/'/g, "\\'");
        const safeTitle = (expert.title || 'Career Mentor').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `
            <div class="card expert-card">
                <div class="avatar-lg">${avatar}</div>
                <h3 style="font-size:1.25rem;font-weight:800;">${expert.fullName || 'Chuyên gia'}</h3>
                <p style="color:var(--text-muted);font-weight:500;margin:0.5rem 0;">${safeTitle}</p>
                <div style="font-weight:800;color:var(--brand-blue);font-size:1.25rem;margin-bottom:1.5rem;">${Number(expert.priceVnd || 0).toLocaleString('vi-VN')}đ</div>
                <button class="btn btn-outline" style="width:100%;" onclick="selectExpert('${String(expert.priceVnd || 0)}','${safeName}','${expert.id}')">Chọn Mentor này</button>
            </div>
        `;
    }).join('');
}

function selectExpert(price, name, expertId = '') {
    sessionStorage.setItem(PENDING_EXPERT_KEY, JSON.stringify({ price: String(price), name, expertId }));
    navigate('booking');
}

function applyPendingExpertSelection() {
    const select = document.getElementById('expert-select');
    if (!select) return;

    const raw = sessionStorage.getItem(PENDING_EXPERT_KEY);
    if (!raw) return;
    sessionStorage.removeItem(PENDING_EXPERT_KEY);

    try {
        const selected = JSON.parse(raw);
        const matched = Array.from(select.options).find((o) => o.dataset.expertId === selected.expertId && selected.expertId);
        if (matched) {
            select.value = matched.value;
        } else {
            const option = document.createElement('option');
            option.value = selected.price;
            option.dataset.expertId = selected.expertId;
            option.dataset.expertName = selected.name;
            option.textContent = `${selected.name} (${Number(selected.price).toLocaleString('vi-VN')}đ)`;
            select.appendChild(option);
            select.value = selected.price;
        }
        updatePrice();
    } catch (_error) {
        // ignore invalid cache
    }
}

function updatePrice() {
    const select = document.getElementById('expert-select');
    const total = document.getElementById('total-price');
    if (!select || !total) return;
    total.innerText = Number(select.value || 0).toLocaleString('vi-VN') + 'đ';
}

function getSelectedExpert() {
    const select = document.getElementById('expert-select');
    if (!select) return { id: null, name: 'Chuyên gia' };
    const option = select.options[select.selectedIndex];
    return {
        id: option?.dataset?.expertId || null,
        name: option?.dataset?.expertName || 'Chuyên gia'
    };
}

function parseVnd(text) {
    return Number(String(text || '').replace(/[^0-9]/g, ''));
}

function formatDateDisplay(isoDate) {
    const [y, m, d] = String(isoDate || '').split('-');
    if (!y || !m || !d) return isoDate;
    return `${d}/${m}/${y}`;
}

function handleFile(event) {
    if (!event?.target?.files?.length) return;
    uploadedFile = event.target.files[0];
    uploadedFileName = uploadedFile.name;

    const txt = document.getElementById('upload-text');
    if (txt) {
        txt.innerText = `Đã chọn file: ${uploadedFileName}`;
        txt.style.color = 'var(--brand-green)';
    }

    const icon = document.querySelector('.upload-area i');
    if (icon) {
        icon.style.color = 'var(--brand-green)';
        icon.className = 'fa-solid fa-file-circle-check';
    }
}

function switchAuthMode(mode) {
    authMode = mode;
    const tabLogin = document.getElementById('tab-login');
    const tabRegister = document.getElementById('tab-register');
    const groupName = document.getElementById('group-name');
    const authNameInput = document.getElementById('auth-name');
    const submitBtn = document.getElementById('auth-submit-btn');
    if (!tabLogin || !tabRegister || !groupName || !authNameInput || !submitBtn) return;

    if (mode === 'login') {
        tabLogin.classList.add('active');
        tabRegister.classList.remove('active');
        groupName.style.display = 'none';
        authNameInput.removeAttribute('required');
        submitBtn.innerText = 'Xác thực & Đăng nhập';
    } else {
        tabLogin.classList.remove('active');
        tabRegister.classList.add('active');
        groupName.style.display = 'block';
        authNameInput.setAttribute('required', 'true');
        submitBtn.innerText = 'Đăng ký tài khoản mới';
    }
}

async function handleAuth(e) {
    e.preventDefault();
    const email = document.getElementById('auth-email')?.value?.trim();
    const password = document.getElementById('auth-password')?.value;
    const fullName = document.getElementById('auth-name')?.value?.trim();
    if (!email || !password) return;

    try {
        const response = authMode === 'register'
            ? await apiFetch('/auth/register', {
                method: 'POST',
                body: JSON.stringify({ email, password, fullName: fullName || email.split('@')[0] })
            })
            : await apiFetch('/auth/login', {
                method: 'POST',
                body: JSON.stringify({ email, password })
            });

        authToken = response.token;
        localStorage.setItem(AUTH_TOKEN_KEY, authToken);
        authUser = response.user;
        currentUser = authUser.fullName;
        isLoggedIn = true;
        setAuthUI(true, currentUser);
        closeModal('auth-modal');
        await loadHistoryFromApi();
    } catch (error) {
        alert(error.message || 'Không thể đăng nhập lúc này.');
    }
}

async function logout() {
    if (!confirm('Bạn muốn đăng xuất?')) return;
    authToken = '';
    localStorage.removeItem(AUTH_TOKEN_KEY);
    isLoggedIn = false;
    authUser = null;
    setAuthUI(false);
    navigate('landing');
}

function triggerPayment() {
    if (!isLoggedIn) return openModal('auth-modal');
    if (!uploadedFileName) return alert('Bạn quên chưa tải CV lên kìa!');

    selectedDate = document.getElementById('booking-date')?.value;
    selectedTime = document.getElementById('booking-time')?.value;
    if (!selectedDate || !selectedTime) return alert('Vui lòng chọn Ngày và Giờ hẹn nhé!');

    const modalPrice = document.getElementById('modal-price');
    const totalPrice = document.getElementById('total-price');
    if (modalPrice && totalPrice) modalPrice.innerText = totalPrice.innerText;
    openModal('payment-modal');
}

async function processPayment() {
    const btn = document.getElementById('confirm-payment-btn');
    if (!btn) return;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang xác thực giao dịch...';
    btn.style.opacity = '0.8';

    try {
        const selected = getSelectedExpert();
        const totalPrice = parseVnd(document.getElementById('total-price')?.innerText);
        const formData = new FormData();
        formData.append('cv', uploadedFile);
        formData.append('bookingDate', selectedDate);
        formData.append('startTime', selectedTime);
        formData.append('priceVnd', String(totalPrice));
        if (selected.id) formData.append('expertId', selected.id);

        await apiFetch('/bookings', { method: 'POST', body: formData });
        closeModal('payment-modal');
        btn.innerHTML = 'Tôi đã chuyển khoản thành công';
        btn.style.opacity = '1';
        navigate('history');
    } catch (error) {
        alert(error.message || 'Có lỗi khi xử lý thanh toán.');
        btn.innerHTML = 'Tôi đã chuyển khoản thành công';
        btn.style.opacity = '1';
    }
}

async function loadHistoryFromApi() {
    const container = document.getElementById('history-container');
    const empty = document.getElementById('empty-history');
    if (!container || !authUser) return;

    try {
        const response = await apiFetch('/bookings/me', { method: 'GET' });
        const bookings = response.bookings || [];

        container.querySelectorAll('.history-item').forEach((el) => el.remove());

        if (!bookings.length) {
            if (empty) empty.style.display = 'block';
            return;
        }

        if (empty) empty.style.display = 'none';
        bookings.forEach((booking) => {
            createHistoryRecord(
                booking.cvName || 'CV.pdf',
                booking.expertName || 'Chuyên gia',
                booking.bookingDateDisplay || formatDateDisplay(booking.bookingDate),
                booking.startTime,
                false
            );
        });
    } catch (error) {
        console.warn('History load error:', error.message);
    }
}

function createHistoryRecord(cvName, expertName, dateStr, timeStr, prepend = true) {
    const container = document.getElementById('history-container');
    const empty = document.getElementById('empty-history');
    if (!container) return;
    if (empty) empty.style.display = 'none';

    const safeCvName = String(cvName).replace(/'/g, "\\'");
    const safeExpertName = String(expertName).replace(/'/g, "\\'");

    const record = document.createElement('div');
    record.className = 'card history-item';
    record.style.cssText = 'padding:1.5rem 2rem; display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem; border-left:4px solid var(--brand-blue);';
    record.innerHTML = `
        <div>
            <h3 style="font-size:1.15rem; font-weight:700; color:#0f172a; margin-bottom:8px;"><i class="fa-solid fa-file-pdf" style="color:#ef4444; margin-right:8px;"></i>${cvName}</h3>
            <div style="color:#475569; font-size:0.95rem; display:flex; gap:20px;">
                <span><i class="fa-solid fa-user-tie" style="color:#94a3b8; width:20px;"></i> ${expertName}</span>
                <span><i class="fa-solid fa-clock" style="color:#94a3b8; width:20px;"></i> ${timeStr} | ${dateStr}</span>
            </div>
        </div>
        <button class="btn btn-primary" style="box-shadow:none;" onclick="joinRoom('${safeCvName}', '${safeExpertName}')"><i class="fa-solid fa-video"></i> Vào phòng chờ</button>
    `;

    if (prepend) container.prepend(record);
    else container.appendChild(record);
}

function joinRoom(cvName, expertName) {
    const params = new URLSearchParams({ cv: cvName, expert: expertName });
    window.location.href = `room.html?${params.toString()}`;
}
