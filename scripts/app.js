const LOCAL_API_BASE_URL = 'http://localhost:3000/api';
const LOCAL_API_BASE_URLS = [
    'http://localhost:3000/api',
    'http://localhost:3001/api',
    'http://localhost:3002/api'
];
const REMOTE_API_BASE_URL = 'https://hireme-dtdx.onrender.com/api';
const RUNNING_ON_LOCALHOST = ['', 'localhost', '127.0.0.1'].includes(window.location.hostname);
const USE_LOCAL_API = RUNNING_ON_LOCALHOST && localStorage.getItem('hireme_use_local_api') === '1';
const API_BASE_URL = USE_LOCAL_API ? LOCAL_API_BASE_URL : REMOTE_API_BASE_URL;
const API_REQUEST_TIMEOUT_MS = 12000;
const LOCAL_API_REQUEST_TIMEOUT_MS = 1800;
const REMOTE_API_REQUEST_TIMEOUT_MS = 30000;
const AUTH_TOKEN_KEY = 'hireme_token';
const AUTH_USER_KEY = 'hireme_user';
const PENDING_EXPERT_KEY = 'hireme_selected_expert';
const EXPERTS_CACHE_KEY = 'hireme_experts_cache';
const HISTORY_CACHE_PREFIX = 'hireme_history_cache_';
const SESSION_ID_KEY = 'hireme_session_id';
const FIRST_VISIT_KEY = 'hireme_first_visit_at';
const EXPERTS_CACHE_TTL_MS = 5 * 60 * 1000;
const HISTORY_CACHE_TTL_MS = 2 * 60 * 1000;
const BOOKING_STATUS_OPTIONS = ['pending_payment', 'confirmed', 'in_room', 'completed', 'cancelled', 'no_show'];

let authToken = localStorage.getItem(AUTH_TOKEN_KEY) || '';
let isLoggedIn = false;
let currentUser = '';
let uploadedFileName = '';
let uploadedFile = null;
let selectedDate = '';
let selectedTime = '';
let authUser = JSON.parse(localStorage.getItem(AUTH_USER_KEY) || 'null');
let authMode = 'login';
let adminExpertsCache = [];
let adminLogsPage = 1;
let adminRetryTimer = null;
let forceRemoteApi = false;
let preferredApiBase = USE_LOCAL_API ? LOCAL_API_BASE_URL : '';

function buildApiBaseCandidates() {
    const unique = (items) => Array.from(new Set(items.filter(Boolean)));
    const prefersLocal = typeof preferredApiBase === 'string' && preferredApiBase.startsWith('http://localhost:');

    if (prefersLocal) {
        return unique([preferredApiBase, ...LOCAL_API_BASE_URLS, REMOTE_API_BASE_URL]);
    }
    if (preferredApiBase === REMOTE_API_BASE_URL || forceRemoteApi) {
        return RUNNING_ON_LOCALHOST
            ? unique([REMOTE_API_BASE_URL, ...LOCAL_API_BASE_URLS])
            : [REMOTE_API_BASE_URL];
    }

    if (RUNNING_ON_LOCALHOST || USE_LOCAL_API) {
        return unique([...LOCAL_API_BASE_URLS, REMOTE_API_BASE_URL]);
    }

    return [API_BASE_URL];
}

function shouldRetryWithNextBase(error, status, currentBase, hasMoreBases) {
    if (!hasMoreBases) return false;

    const isNetworkError =
        error?.name === 'AbortError' ||
        error?.message === 'Failed to fetch' ||
        error instanceof TypeError;
    if (isNetworkError) return true;

    // When remote does not have the latest admin/log endpoints, try local backend.
    if (currentBase === REMOTE_API_BASE_URL && [401, 404, 405].includes(Number(status || 0))) {
        return true;
    }

    return false;
}

function toFriendlyNetworkError(error) {
    const message = String(error?.message || '');
    if (error?.name === 'AbortError') {
        return new Error('Yêu cầu quá thời gian phản hồi. Vui lòng thử lại sau vài giây.');
    }
    if (message === 'Failed to fetch' || error instanceof TypeError) {
        return new Error('Không thể kết nối API. Hãy chắc chắn backend local đang chạy ở cổng 3000/3001/3002 hoặc kiểm tra mạng internet.');
    }
    return error;
}

function shouldRetryAdminLoad(error) {
    const message = String(error?.message || '').toLowerCase();
    return message.includes('không thể kết nối api')
        || message.includes('failed to fetch')
        || message.includes('database đang kết nối lại')
        || message.includes('quá thời gian phản hồi');
}

function scheduleAdminAutoRetry() {
    if (adminRetryTimer) return;
    adminRetryTimer = setTimeout(async () => {
        adminRetryTimer = null;
        if (document.body?.dataset?.page !== 'admin') return;
        if (authUser?.role !== 'admin') return;
        await loadAdminPage();
    }, 3000);
}

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
        history: 'history.html',
        admin: 'admin.html'
    }[pageId] || 'index.html';
}

function inferPageIdFromRoute(route) {
    const file = String(route || '').split('/').pop();
    const map = {
        'index.html': 'landing',
        'booking.html': 'booking',
        'experts.html': 'experts',
        'history.html': 'history',
        'admin.html': 'admin'
    };
    return map[file] || 'landing';
}

function urlForPage(pageId) {
    if (pageId === 'landing') return 'index.html';
    return `index.html?page=${pageId}`;
}

function currentPageFromUrl() {
    const page = new URLSearchParams(window.location.search).get('page');
    if (page && ['landing', 'booking', 'experts', 'history', 'admin'].includes(page)) {
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
    } catch (error) {
        // Keep current view to avoid unexpected hard refresh on transient fetch issues.
        console.warn('Page dynamic load failed:', error.message);
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
    syncAdminNavVisibility();
    enforceAdminOnlyExperience();

    const dateInput = document.getElementById('booking-date');
    if (dateInput) {
        dateInput.setAttribute('min', new Date().toISOString().split('T')[0]);
    }

    // Keep experts publicly visible even when auth check fails or is slow.
    await Promise.allSettled([
        loadExpertsFromApi(),
        hydrateAuthFromToken()
    ]);
    applyPendingExpertSelection();

    if (document.body?.dataset?.page === 'admin') {
        await loadAdminPage();
    }

    trackActivity(`view_${document.body?.dataset?.page || 'landing'}`, {
        page: document.body?.dataset?.page || 'landing'
    });
}

function markActiveNav() {
    const page = document.body?.dataset?.page;
    if (!page) return;
    ensureAdminNavItem();
    document.querySelectorAll('.nav-links li').forEach((item) => item.classList.remove('active'));
    const nav = document.getElementById(`nav-${page}`);
    if (nav) nav.classList.add('active');
}

function ensureAdminNavItem() {
    const navLists = document.querySelectorAll('.nav-links');
    navLists.forEach((list) => {
        let adminLi = list.querySelector('#nav-admin');
        if (!adminLi) {
            adminLi = document.createElement('li');
            adminLi.id = 'nav-admin';
            adminLi.textContent = 'Quan tri';
            adminLi.onclick = () => navigate('admin');
            list.appendChild(adminLi);
        }
    });
}

function syncAdminNavVisibility() {
    ensureAdminNavItem();
    const isAdmin = authUser?.role === 'admin';
    document.querySelectorAll('#nav-admin').forEach((item) => {
        item.style.display = isAdmin ? '' : 'none';
    });
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
    syncAdminNavVisibility();
    enforceAdminOnlyExperience();
}

function readCache(key, ttlMs) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed?.savedAt || !Array.isArray(parsed?.data)) return null;
        if (Date.now() - parsed.savedAt > ttlMs) return null;
        return parsed.data;
    } catch (_error) {
        return null;
    }
}

function writeCache(key, data) {
    try {
        localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), data }));
    } catch (_error) {
        // ignore storage failure
    }
}

function getSessionId() {
    let sessionId = localStorage.getItem(SESSION_ID_KEY);
    if (sessionId) return sessionId;
    sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(SESSION_ID_KEY, sessionId);
    return sessionId;
}

function getCustomerTypeClientHint() {
    if (localStorage.getItem('hireme_has_booking') === '1') return 'returning';

    const firstVisit = Number(localStorage.getItem(FIRST_VISIT_KEY) || 0);
    if (!firstVisit) {
        localStorage.setItem(FIRST_VISIT_KEY, String(Date.now()));
        return 'new';
    }

    const days = (Date.now() - firstVisit) / (1000 * 60 * 60 * 24);
    return days >= 7 ? 'returning' : 'new';
}

function detectDeviceClient() {
    const ua = navigator.userAgent || '';
    if (/Mobi|Android/i.test(ua)) return 'mobile';
    if (/iPad|Tablet/i.test(ua)) return 'tablet';
    return 'desktop';
}

function detectChannelClient() {
    const url = new URL(window.location.href);
    const utmSource = url.searchParams.get('utm_source');
    if (utmSource) return utmSource;
    if (document.referrer) {
        try {
            return new URL(document.referrer).hostname || 'referral';
        } catch (_error) {
            return 'referral';
        }
    }
    return 'direct';
}

function trackActivity(activity, metadata = {}) {
    if (!activity) return;
    void apiFetch('/activity-logs', {
        method: 'POST',
        body: JSON.stringify({
            activity,
            metadata,
            channel: detectChannelClient(),
            device: detectDeviceClient(),
            customerType: getCustomerTypeClientHint(),
            sessionId: getSessionId()
        })
    }).catch(() => {});
}

function enforceAdminOnlyExperience() {
    const isAdmin = authUser?.role === 'admin';
    const page = document.body?.dataset?.page;

    ['nav-landing', 'nav-booking', 'nav-experts', 'nav-history'].forEach((id) => {
        const navItem = document.getElementById(id);
        if (!navItem) return;
        navItem.style.display = isAdmin ? 'none' : '';
    });

    const logo = document.querySelector('#main-header .logo');
    if (logo) {
        logo.style.pointerEvents = isAdmin ? 'none' : '';
        logo.style.opacity = isAdmin ? '0.7' : '';
    }

    if (isAdmin && page && page !== 'admin') {
        navigate('admin');
    }
}

async function apiFetch(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (!(options.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
    }
    if (authToken) {
        headers.Authorization = `Bearer ${authToken}`;
    }
    headers['X-Session-Id'] = getSessionId();
    headers['X-Channel'] = detectChannelClient();
    headers['X-Device'] = detectDeviceClient();
    headers['X-Customer-Type'] = getCustomerTypeClientHint();

    const requestOptions = { ...options, headers };
    const baseUrls = buildApiBaseCandidates();

    let lastNetworkError = null;

    for (let i = 0; i < baseUrls.length; i += 1) {
        const baseUrl = baseUrls[i];
        try {
            const controller = new AbortController();
            const timeoutMs = baseUrl === REMOTE_API_BASE_URL
                ? REMOTE_API_REQUEST_TIMEOUT_MS
                : LOCAL_API_REQUEST_TIMEOUT_MS;
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            const response = await fetch(`${baseUrl}${path}`, {
                ...requestOptions,
                signal: controller.signal
            }).finally(() => clearTimeout(timeoutId));
            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                const apiError = new Error(data.message || 'Có lỗi xảy ra khi gọi API.');
                apiError.status = response.status;
                if (shouldRetryWithNextBase(apiError, response.status, baseUrl, i < baseUrls.length - 1)) {
                    lastNetworkError = apiError;
                    continue;
                }
                throw apiError;
            }

            if (i > 0 && API_BASE_URL !== baseUrl) {
                console.warn('Switched API endpoint due to local connection issue:', baseUrl);
            }

            preferredApiBase = baseUrl;
            forceRemoteApi = baseUrl === REMOTE_API_BASE_URL;

            return data;
        } catch (error) {
            lastNetworkError = error;

            const shouldRetry = shouldRetryWithNextBase(error, error?.status, baseUrl, i < baseUrls.length - 1);
            if (shouldRetry) {
                continue;
            }
            break;
        }
    }

    const normalizedError = toFriendlyNetworkError(lastNetworkError);
    throw new Error(normalizedError?.message || 'Không thể kết nối đến hệ thống API.');
}

async function hydrateAuthFromToken() {
    if (!authToken) {
        setAuthUI(false);
        if (document.body?.dataset?.page === 'admin') {
            navigate('landing');
        }
        return;
    }

    try {
        const me = await apiFetch('/auth/me');
        authUser = me.user;
        localStorage.setItem(AUTH_USER_KEY, JSON.stringify(authUser));
        currentUser = authUser.fullName;
        isLoggedIn = true;
        setAuthUI(true, currentUser);

        const currentPage = document.body?.dataset?.page;
        if (authUser.role !== 'admin' && currentPage === 'history') {
            await loadHistoryFromApi();
        }
    } catch (error) {
        if (error?.status === 401 || error?.status === 403) {
            authToken = '';
            localStorage.removeItem(AUTH_TOKEN_KEY);
            localStorage.removeItem(AUTH_USER_KEY);
            isLoggedIn = false;
            authUser = null;
            setAuthUI(false);
            if (document.body?.dataset?.page === 'admin') {
                navigate('landing');
            }
            return;
        }

        // Do not auto-logout on temporary network/API timeout.
        const cachedUser = JSON.parse(localStorage.getItem(AUTH_USER_KEY) || 'null');
        if (cachedUser) {
            authUser = cachedUser;
            currentUser = cachedUser.fullName;
            isLoggedIn = true;
            setAuthUI(true, currentUser);
            return;
        }

        console.warn('Auth refresh skipped due to temporary network issue:', error.message);
    }
}

async function loadExpertsFromApi() {
    const select = document.getElementById('expert-select');
    const grid = document.getElementById('experts-grid');
    if (!select && !grid) return;

    const cachedExperts = readCache(EXPERTS_CACHE_KEY, EXPERTS_CACHE_TTL_MS);
    if (cachedExperts?.length) {
        if (select) {
            select.innerHTML = '<option value="150000" data-expert-id="">Hệ thống phân công ngẫu nhiên - 150.000đ</option>';
            cachedExperts.forEach((expert) => {
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
            renderExpertsGrid(cachedExperts);
        }
    }

    try {
        const response = await apiFetch('/experts', { method: 'GET' });
        const experts = response.experts || [];
        writeCache(EXPERTS_CACHE_KEY, experts);

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
    trackActivity('select_expert', {
        expertId: expertId || null,
        expertName: name,
        priceVnd: Number(price || 0)
    });
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
        localStorage.setItem(AUTH_USER_KEY, JSON.stringify(authUser));
        currentUser = authUser.fullName;
        isLoggedIn = true;
        setAuthUI(true, currentUser);
        trackActivity(authMode === 'register' ? 'register_success' : 'login_success', { email });
        closeModal('auth-modal');

        const currentPage = document.body?.dataset?.page;
        if (authUser.role !== 'admin' && currentPage === 'history') {
            await loadHistoryFromApi();
        }
        if (authUser.role === 'admin' && currentPage !== 'admin') {
            navigate('admin');
        }
        if (document.body?.dataset?.page === 'admin') {
            await loadAdminPage();
        }
    } catch (error) {
        alert(error.message || 'Không thể đăng nhập lúc này.');
    }
}

async function logout() {
    if (!confirm('Bạn muốn đăng xuất?')) return;
    authToken = '';
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
    isLoggedIn = false;
    authUser = null;
    setAuthUI(false);
    trackActivity('logout', {});
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
    trackActivity('payment_modal_opened', {
        bookingDate: selectedDate,
        startTime: selectedTime,
        totalPriceVnd: parseVnd(totalPrice?.innerText)
    });
    openModal('payment-modal');
}

async function processPayment() {
    const btn = document.getElementById('confirm-payment-btn');
    if (!btn) return;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang xác thực giao dịch...';
    btn.style.opacity = '0.8';
    btn.disabled = true;

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
        localStorage.setItem('hireme_has_booking', '1');
        trackActivity('booking_created', {
            bookingDate: selectedDate,
            startTime: selectedTime,
            totalPriceVnd: totalPrice,
            expertId: selected.id || null
        });
        closeModal('payment-modal');
        navigate('history');
    } catch (error) {
        trackActivity('booking_failed', {
            bookingDate: selectedDate,
            startTime: selectedTime,
            reason: error.message || 'unknown_error'
        });
        alert(error.message || 'Có lỗi khi xử lý thanh toán.');
    } finally {
        btn.innerHTML = 'Tôi đã chuyển khoản thành công';
        btn.style.opacity = '1';
        btn.disabled = false;
    }
}

async function loadHistoryFromApi() {
    const container = document.getElementById('history-container');
    const empty = document.getElementById('empty-history');
    if (!container || !authUser) return;

    const historyCacheKey = `${HISTORY_CACHE_PREFIX}${authUser.id || authUser.email || 'me'}`;
    const cachedBookings = readCache(historyCacheKey, HISTORY_CACHE_TTL_MS);
    if (Array.isArray(cachedBookings) && cachedBookings.length) {
        container.querySelectorAll('.history-item').forEach((el) => el.remove());
        if (empty) empty.style.display = 'none';
        cachedBookings.forEach((booking) => {
            createHistoryRecord(
                booking.cvName || 'CV.pdf',
                booking.expertName || 'Chuyên gia',
                booking.bookingDateDisplay || formatDateDisplay(booking.bookingDate),
                booking.startTime,
                false
            );
        });
    }

    try {
        const response = await apiFetch('/bookings/me', { method: 'GET' });
        const bookings = response.bookings || [];
        writeCache(historyCacheKey, bookings);

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

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

async function loadAdminPage() {
    const container = document.getElementById('admin-page');
    if (!container) return;

    if (!authUser) {
        alert('Vui lòng đăng nhập để truy cập trang quản trị.');
        navigate('landing');
        return;
    }

    if (authUser.role !== 'admin') {
        alert('Bạn không có quyền truy cập trang quản trị.');
        navigate('landing');
        return;
    }

    await Promise.allSettled([
        loadAdminUsers(),
        loadAdminExperts(),
        loadAdminBookings(),
        loadAdminActivityLogs(1)
    ]);
}

async function loadAdminUsers() {
    const tbody = document.getElementById('admin-users-tbody');
    if (!tbody) return;

    try {
        const response = await apiFetch('/admin/users', { method: 'GET' });
        const users = response.users || [];
        tbody.innerHTML = users.map((user) => {
            const checked = user.isActive ? 'checked' : '';
            const disabled = String(user.id) === String(authUser?.id) ? 'disabled' : '';
            return `
                <tr>
                    <td>${escapeHtml(user.fullName)}</td>
                    <td>${escapeHtml(user.email)}</td>
                    <td>${escapeHtml(user.role)}</td>
                    <td>
                        <label style="display:flex;align-items:center;gap:8px;">
                            <input type="checkbox" ${checked} ${disabled} onchange="updateUserActive('${user.id}', this.checked)">
                            <span>${user.isActive ? 'Active' : 'Locked'}</span>
                        </label>
                    </td>
                </tr>
            `;
        }).join('');
    } catch (error) {
        if (shouldRetryAdminLoad(error)) scheduleAdminAutoRetry();
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:#ef4444;">${escapeHtml(error.message)}</td></tr>`;
    }
}

async function updateUserActive(userId, isActive) {
    try {
        await apiFetch(`/admin/users/${userId}/is-active`, {
            method: 'PATCH',
            body: JSON.stringify({ isActive })
        });
    } catch (error) {
        alert(error.message || 'Không thể cập nhật trạng thái user.');
    } finally {
        await loadAdminUsers();
    }
}

async function loadAdminExperts() {
    const tbody = document.getElementById('admin-experts-tbody');
    const assignSelect = document.getElementById('booking-edit-expert');
    if (!tbody) return;

    try {
        const response = await apiFetch('/admin/experts', { method: 'GET' });
        const experts = response.experts || [];
        adminExpertsCache = experts;

        tbody.innerHTML = experts.map((expert) => {
            return `
                <tr>
                    <td>${escapeHtml(expert.fullName)}</td>
                    <td>${escapeHtml(expert.email)}</td>
                    <td>${escapeHtml(expert.title)}</td>
                    <td>${Number(expert.basePriceVnd || 0).toLocaleString('vi-VN')}đ</td>
                    <td>${expert.isAvailable ? 'Available' : 'Unavailable'}</td>
                    <td style="display:flex;gap:8px;">
                        <button class="btn btn-outline" style="padding:0.45rem 0.8rem;" onclick="fillExpertForm('${expert.id}')">Sua</button>
                        <button class="btn btn-outline" style="padding:0.45rem 0.8rem;border-color:#ef4444;color:#ef4444;" onclick="deleteExpert('${expert.id}')">Xoa</button>
                    </td>
                </tr>
            `;
        }).join('');

        if (assignSelect) {
            assignSelect.innerHTML = '<option value="">Chua phan cong</option>' + experts
                .map((expert) => `<option value="${expert.id}">${escapeHtml(expert.fullName)}</option>`)
                .join('');
        }
    } catch (error) {
        if (shouldRetryAdminLoad(error)) scheduleAdminAutoRetry();
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#ef4444;">${escapeHtml(error.message)}</td></tr>`;
    }
}

function fillExpertForm(expertId) {
    const expert = adminExpertsCache.find((item) => String(item.id) === String(expertId));
    if (!expert) return;

    const idInput = document.getElementById('expert-id');
    const emailInput = document.getElementById('expert-email');
    const fullNameInput = document.getElementById('expert-name');
    const titleInput = document.getElementById('expert-title');
    const yearsInput = document.getElementById('expert-years');
    const priceInput = document.getElementById('expert-price');
    const availableInput = document.getElementById('expert-available');
    const activeInput = document.getElementById('expert-user-active');

    if (idInput) idInput.value = expert.id || '';
    if (emailInput) {
        emailInput.value = expert.email || '';
        emailInput.disabled = true;
    }
    if (fullNameInput) fullNameInput.value = expert.fullName || '';
    if (titleInput) titleInput.value = expert.title || '';
    if (yearsInput) yearsInput.value = String(expert.yearsExperience || 0);
    if (priceInput) priceInput.value = String(expert.basePriceVnd || 0);
    if (availableInput) availableInput.checked = !!expert.isAvailable;
    if (activeInput) activeInput.checked = !!expert.userIsActive;
}

function resetExpertForm() {
    const form = document.getElementById('expert-form');
    if (!form) return;
    form.reset();
    const idInput = document.getElementById('expert-id');
    const emailInput = document.getElementById('expert-email');
    if (idInput) idInput.value = '';
    if (emailInput) emailInput.disabled = false;
}

async function submitExpertForm(event) {
    event.preventDefault();

    const id = document.getElementById('expert-id')?.value?.trim();
    const email = document.getElementById('expert-email')?.value?.trim();
    const fullName = document.getElementById('expert-name')?.value?.trim();
    const title = document.getElementById('expert-title')?.value?.trim();
    const yearsExperience = Number(document.getElementById('expert-years')?.value || 0);
    const basePriceVnd = Number(document.getElementById('expert-price')?.value || 0);
    const isAvailable = !!document.getElementById('expert-available')?.checked;
    const userIsActive = !!document.getElementById('expert-user-active')?.checked;

    if (!fullName || !title || !basePriceVnd || (!id && !email)) {
        alert('Vui lòng nhập đầy đủ thông tin bắt buộc cho chuyên gia.');
        return;
    }

    try {
        if (id) {
            await apiFetch(`/admin/experts/${id}`, {
                method: 'PUT',
                body: JSON.stringify({ fullName, title, yearsExperience, basePriceVnd, isAvailable, userIsActive })
            });
        } else {
            await apiFetch('/admin/experts', {
                method: 'POST',
                body: JSON.stringify({ email, fullName, title, yearsExperience, basePriceVnd, isAvailable })
            });
        }

        resetExpertForm();
        await loadAdminExperts();
    } catch (error) {
        alert(error.message || 'Không thể lưu chuyên gia.');
    }
}

async function deleteExpert(expertId) {
    if (!confirm('Xác nhận xóa chuyên gia này?')) return;

    try {
        await apiFetch(`/admin/experts/${expertId}`, { method: 'DELETE' });
        await loadAdminExperts();
        await loadAdminBookings();
    } catch (error) {
        alert(error.message || 'Không thể xóa chuyên gia.');
    }
}

async function loadAdminBookings() {
    const tbody = document.getElementById('admin-bookings-tbody');
    if (!tbody) return;

    try {
        const response = await apiFetch('/admin/bookings', { method: 'GET' });
        const bookings = response.bookings || [];

        tbody.innerHTML = bookings.map((booking) => {
            return `
                <tr>
                    <td>${escapeHtml(booking.candidateName)}</td>
                    <td>${escapeHtml(booking.expertName)}</td>
                    <td>${escapeHtml(booking.bookingDateDisplay)} ${escapeHtml(booking.startTime)}</td>
                    <td>${Number(booking.priceVnd || 0).toLocaleString('vi-VN')}đ</td>
                    <td>${escapeHtml(booking.status)}</td>
                    <td style="display:flex;gap:8px;">
                        <button class="btn btn-outline" style="padding:0.45rem 0.8rem;" onclick="openBookingEditor('${booking.id}','${booking.status}','${booking.expertId || ''}')">Sua</button>
                        <button class="btn btn-outline" style="padding:0.45rem 0.8rem;border-color:#ef4444;color:#ef4444;" onclick="deleteBooking('${booking.id}')">Xoa</button>
                    </td>
                </tr>
            `;
        }).join('');
    } catch (error) {
        if (shouldRetryAdminLoad(error)) scheduleAdminAutoRetry();
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#ef4444;">${escapeHtml(error.message)}</td></tr>`;
    }
}

function openBookingEditor(bookingId, status, expertId) {
    const idInput = document.getElementById('booking-edit-id');
    const statusInput = document.getElementById('booking-edit-status');
    const expertInput = document.getElementById('booking-edit-expert');
    if (idInput) idInput.value = bookingId;
    if (statusInput) statusInput.value = BOOKING_STATUS_OPTIONS.includes(status) ? status : 'confirmed';
    if (expertInput) expertInput.value = expertId || '';
}

async function updateBookingByEditor() {
    const bookingId = document.getElementById('booking-edit-id')?.value;
    const status = document.getElementById('booking-edit-status')?.value;
    const expertId = document.getElementById('booking-edit-expert')?.value || '';

    if (!bookingId || !status) {
        alert('Vui lòng chọn lịch hẹn cần sửa và trạng thái.');
        return;
    }

    try {
        await apiFetch(`/admin/bookings/${bookingId}`, {
            method: 'PATCH',
            body: JSON.stringify({ status, expertId })
        });
        await loadAdminBookings();
    } catch (error) {
        alert(error.message || 'Không thể cập nhật lịch hẹn.');
    }
}

async function deleteBooking(bookingId) {
    if (!confirm('Xác nhận xóa lịch hẹn này?')) return;

    try {
        await apiFetch(`/admin/bookings/${bookingId}`, { method: 'DELETE' });
        await loadAdminBookings();
    } catch (error) {
        alert(error.message || 'Không thể xóa lịch hẹn.');
    }
}

async function apiFetchBlob(path) {
    const headers = {};
    if (authToken) {
        headers.Authorization = `Bearer ${authToken}`;
    }
    headers['X-Session-Id'] = getSessionId();
    headers['X-Channel'] = detectChannelClient();
    headers['X-Device'] = detectDeviceClient();
    headers['X-Customer-Type'] = getCustomerTypeClientHint();

    const baseUrls = buildApiBaseCandidates();

    let lastError = null;
    for (let i = 0; i < baseUrls.length; i += 1) {
        const baseUrl = baseUrls[i];
        try {
            const controller = new AbortController();
            const timeoutMs = baseUrl === REMOTE_API_BASE_URL
                ? REMOTE_API_REQUEST_TIMEOUT_MS
                : LOCAL_API_REQUEST_TIMEOUT_MS;
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            const response = await fetch(`${baseUrl}${path}`, {
                method: 'GET',
                headers,
                signal: controller.signal
            }).finally(() => clearTimeout(timeoutId));

            if (!response.ok) {
                const text = await response.text();
                const err = new Error(text || 'Export failed');
                err.status = response.status;
                if (shouldRetryWithNextBase(err, response.status, baseUrl, i < baseUrls.length - 1)) {
                    lastError = err;
                    continue;
                }
                throw err;
            }

            preferredApiBase = baseUrl;
            forceRemoteApi = baseUrl === REMOTE_API_BASE_URL;
            return await response.blob();
        } catch (error) {
            lastError = error;
            if (shouldRetryWithNextBase(error, error?.status, baseUrl, i < baseUrls.length - 1)) continue;
        }
    }

    const normalizedError = toFriendlyNetworkError(lastError);
    throw new Error(normalizedError?.message || 'Không thể export file.');
}

function buildAdminLogsQuery(page = 1) {
    const activity = document.getElementById('log-filter-activity')?.value?.trim() || '';
    const channel = document.getElementById('log-filter-channel')?.value?.trim() || '';
    const customerType = document.getElementById('log-filter-customer-type')?.value || '';
    const from = document.getElementById('log-filter-from')?.value || '';
    const to = document.getElementById('log-filter-to')?.value || '';

    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('limit', '50');
    if (activity) params.set('activity', activity);
    if (channel) params.set('channel', channel);
    if (customerType) params.set('customerType', customerType);
    if (from) params.set('from', from);
    if (to) params.set('to', `${to}T23:59:59.999Z`);
    return params;
}

async function loadAdminActivityLogs(page = 1) {
    const tbody = document.getElementById('admin-logs-tbody');
    const summary = document.getElementById('admin-logs-summary');
    if (!tbody) return;

    adminLogsPage = page;
    try {
        const params = buildAdminLogsQuery(page);
        const response = await apiFetch(`/admin/activity-logs?${params.toString()}`, { method: 'GET' });
        const logs = response.logs || [];

        tbody.innerHTML = logs.map((log) => `
            <tr>
                <td>${escapeHtml(log.sessionId || '')}</td>
                <td>${escapeHtml(log.activity || '')}</td>
                <td>${escapeHtml(new Date(log.timestamp).toLocaleString('vi-VN'))}</td>
                <td>${escapeHtml(log.channel || '')}</td>
                <td>${escapeHtml(log.device || '')}</td>
                <td>${escapeHtml(log.customerType || '')}</td>
                <td>${escapeHtml(log.path || '')}</td>
                <td>${escapeHtml(String(log.statusCode || ''))}</td>
            </tr>
        `).join('');

        if (!logs.length) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#64748b;">Chưa có dữ liệu log.</td></tr>';
        }

        if (summary) {
            summary.innerText = `Tổng: ${Number(response.total || 0).toLocaleString('vi-VN')} logs | Trang ${response.page || 1}`;
        }
    } catch (error) {
        if (shouldRetryAdminLoad(error)) scheduleAdminAutoRetry();
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#ef4444;">${escapeHtml(error.message)}</td></tr>`;
    }
}

async function exportAdminActivityLogs() {
    try {
        const params = buildAdminLogsQuery(1);
        params.delete('page');
        params.delete('limit');
        const blob = await apiFetchBlob(`/admin/activity-logs/export?${params.toString()}`);
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `activity-logs-${Date.now()}.xlsx`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    } catch (error) {
        alert(error.message || 'Không thể export log lúc này.');
    }
}

function prevAdminLogsPage() {
    const next = Math.max(1, adminLogsPage - 1);
    loadAdminActivityLogs(next);
}

function nextAdminLogsPage() {
    loadAdminActivityLogs(adminLogsPage + 1);
}
