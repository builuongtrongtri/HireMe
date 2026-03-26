const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const XLSX = require('xlsx');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const mongoUri = process.env.MONGODB_URI;
const jwtSecret = process.env.JWT_SECRET;

if (!mongoUri || !jwtSecret) {
  console.error('Missing MONGODB_URI or JWT_SECRET in environment variables.');
  process.exit(1);
}

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/\s+/g, '_');
    cb(null, `${Date.now()}-${safeName}`);
  }
});
const upload = multer({ storage });
const SERVER_CV_COMPRESSION_THRESHOLD_BYTES = 2 * 1024 * 1024;
const SERVER_CV_COMPRESSION_MIN_SAVING_BYTES = 120 * 1024;

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    fullName: { type: String, required: true, trim: true },
    role: { type: String, enum: ['candidate', 'expert', 'admin'], default: 'candidate' },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

const expertProfileSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    title: { type: String, required: true },
    bio: { type: String, default: '' },
    yearsExperience: { type: Number, default: 0 },
    basePriceVnd: { type: Number, required: true },
    avatarUrl: { type: String, default: '' },
    isAvailable: { type: Boolean, default: true },
    rating: { type: Number, default: 0 },
    totalReviews: { type: Number, default: 0 }
  },
  { timestamps: true }
);

const cvFileSchema = new mongoose.Schema(
  {
    candidateId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    originalFilename: { type: String, required: true },
    storageKey: { type: String, required: true, unique: true },
    mimeType: { type: String, required: true },
    fileSizeBytes: { type: Number, required: true }
  },
  { timestamps: true }
);

const bookingSchema = new mongoose.Schema(
  {
    candidateId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    expertId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExpertProfile', default: null },
    cvFileId: { type: mongoose.Schema.Types.ObjectId, ref: 'CvFile', required: true },
    bookingDate: { type: String, required: true },
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    priceVnd: { type: Number, required: true },
    status: {
      type: String,
      enum: ['pending_payment', 'confirmed', 'in_room', 'completed', 'cancelled', 'no_show'],
      default: 'confirmed'
    },
    payment: {
      provider: { type: String, default: 'bank_transfer_qr' },
      status: { type: String, enum: ['initiated', 'paid', 'failed', 'refunded'], default: 'paid' },
      paidAt: { type: Date, default: Date.now }
    }
  },
  { timestamps: true }
);

const ACTIVITY_LABELS = {
  login: 'Đăng nhập',
  logout: 'Đăng xuất',
  login_failed: 'Đăng nhập thất bại',
  register_success: 'Đăng ký thành công',
  register_failed: 'Đăng ký thất bại',
  page_home_view: 'Truy cập trang chủ',
  page_experts_view: 'Truy cập trang experts',
  page_booking_view: 'Truy cập trang booking',
  page_history_view: 'Truy cập trang history',
  page_room_view: 'Truy cập trang room',
  auth_modal_opened: 'Mở modal đăng nhập',
  auth_mode_switched: 'Chuyển tab login/register',
  expert_selected: 'Chọn chuyên gia',
  cv_uploaded: 'Upload CV',
  payment_modal_opened: 'Mở modal thanh toán',
  booking_created: 'Booking thành công',
  booking_failed: 'Booking thất bại',
  history_loaded: 'Load lịch sử thành công',
  history_load_failed: 'Load lịch sử thất bại',
  room_join_clicked: 'Bấm vào phòng chờ',
  admin_user_status_updated: 'Admin cập nhật trạng thái user',
  admin_expert_created: 'Admin tạo expert',
  admin_expert_updated: 'Admin cập nhật expert',
  admin_expert_deleted: 'Admin xóa expert',
  admin_booking_updated: 'Admin cập nhật lịch hẹn',
  admin_booking_deleted: 'Admin xóa lịch hẹn',
  admin_logs_exported: 'Admin export checklog'
};

const ACTIVITY_LABEL_ALIASES = {
  'Truy cập trang chuyên gia': ACTIVITY_LABELS.page_experts_view,
  'Truy cập trang đặt lịch': ACTIVITY_LABELS.page_booking_view,
  'Truy cập trang lịch sử': ACTIVITY_LABELS.page_history_view,
  'Truy cập phòng chờ': ACTIVITY_LABELS.page_room_view,
  'Chuyển tab đăng nhập/đăng ký': ACTIVITY_LABELS.auth_mode_switched,
  'Tải CV lên': ACTIVITY_LABELS.cv_uploaded,
  'Đặt lịch tư vấn thành công': ACTIVITY_LABELS.booking_created,
  'Đặt lịch tư vấn thất bại': ACTIVITY_LABELS.booking_failed,
  'Tải lịch sử lịch hẹn': ACTIVITY_LABELS.history_loaded,
  'Tải lịch sử lịch hẹn thất bại': ACTIVITY_LABELS.history_load_failed,
  'Vào phòng chờ': ACTIVITY_LABELS.room_join_clicked
};

const activityLogSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, index: true },
    activity: {
      type: String,
      required: true,
      enum: Object.values(ACTIVITY_LABELS),
      index: true
    },
    timestamp: { type: Date, default: Date.now, index: true },
    channel: { type: String, default: 'direct', index: true },
    device: { type: String, default: 'desktop' },
    customerType: { type: String, enum: ['new', 'returning'], default: 'new', index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: false }
);

expertProfileSchema.index({ isAvailable: 1, basePriceVnd: 1 });
bookingSchema.index({ candidateId: 1, createdAt: -1 });
activityLogSchema.index({ timestamp: -1 });

const User = mongoose.model('User', userSchema);
const ExpertProfile = mongoose.model('ExpertProfile', expertProfileSchema);
const CvFile = mongoose.model('CvFile', cvFileSchema);
const Booking = mongoose.model('Booking', bookingSchema);
const ActivityLog = mongoose.model('ActivityLog', activityLogSchema);

let isMongoReady = false;
let expertsSeeded = false;
let activePort = null;

function createToken(user) {
  return jwt.sign(
    {
      sub: user._id.toString(),
      email: user.email,
      role: user.role
    },
    jwtSecret,
    { expiresIn: '7d' }
  );
}

function formatDateDisplay(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

function plus45Min(startTime) {
  const [h, m] = startTime.split(':').map(Number);
  const total = h * 60 + m + 45;
  const endH = String(Math.floor(total / 60)).padStart(2, '0');
  const endM = String(total % 60).padStart(2, '0');
  return `${endH}:${endM}`;
}

function parsePositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  if (typeof max === 'number') return Math.min(parsed, max);
  return parsed;
}

function parseDateBoundary(value, isEnd = false) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const normalized = raw.includes('T') ? raw : `${raw}${isEnd ? 'T23:59:59.999Z' : 'T00:00:00.000Z'}`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function toIsoDateTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

async function optimizeUploadedCvFile(file) {
  if (!file?.path || !file?.filename) {
    return {
      storageKey: file?.filename || '',
      mimeType: file?.mimetype || 'application/pdf',
      fileSizeBytes: Number(file?.size || 0)
    };
  }

  if (Number(file.size || 0) < SERVER_CV_COMPRESSION_THRESHOLD_BYTES) {
    return {
      storageKey: file.filename,
      mimeType: file.mimetype || 'application/pdf',
      fileSizeBytes: Number(file.size || 0)
    };
  }

  const sourcePath = file.path;
  const gzipPath = `${sourcePath}.gz`;

  try {
    await pipeline(
      fs.createReadStream(sourcePath),
      zlib.createGzip({ level: 6 }),
      fs.createWriteStream(gzipPath)
    );

    const gzipStat = await fs.promises.stat(gzipPath);
    const savedBytes = Number(file.size || 0) - Number(gzipStat.size || 0);

    if (savedBytes < SERVER_CV_COMPRESSION_MIN_SAVING_BYTES) {
      await fs.promises.unlink(gzipPath).catch(() => {});
      return {
        storageKey: file.filename,
        mimeType: file.mimetype || 'application/pdf',
        fileSizeBytes: Number(file.size || 0)
      };
    }

    await fs.promises.unlink(sourcePath).catch(() => {});
    return {
      storageKey: path.basename(gzipPath),
      mimeType: 'application/gzip',
      fileSizeBytes: Number(gzipStat.size || 0)
    };
  } catch (_error) {
    await fs.promises.unlink(gzipPath).catch(() => {});
    return {
      storageKey: file.filename,
      mimeType: file.mimetype || 'application/pdf',
      fileSizeBytes: Number(file.size || 0)
    };
  }
}

async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const payload = jwt.verify(token, jwtSecret);
    const user = await User.findById(payload.sub);
    if (!user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    if (!user.isActive) {
      await writeActivityLog(req, ACTIVITY_LABELS.login_failed, user._id);
      return res.status(403).json({ message: 'Tài khoản của bạn đang bị khóa.' });
    }

    req.user = user;
    next();
  } catch (_error) {
    return res.status(401).json({ message: 'Token không hợp lệ hoặc đã hết hạn.' });
  }
}

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Bạn không có quyền truy cập chức năng này.' });
  }
  return next();
}

function normalizeCaseSessionId(raw) {
  const value = String(raw || '').trim();
  if (/^case[A-Za-z0-9]{4}$/.test(value)) return value;
  const seed = Math.random().toString(36).slice(2).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return `case${seed.slice(0, 4).padEnd(4, '0')}`;
}

function detectDevice(userAgent = '') {
  const ua = String(userAgent).toLowerCase();
  if (!ua) return 'desktop';
  if (ua.includes('ipad') || ua.includes('tablet')) return 'tablet';
  if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) return 'mobile';
  return 'desktop';
}

function resolveChannel(req) {
  const fromHeader = String(req.headers['x-channel'] || '').trim();
  if (fromHeader) return fromHeader.slice(0, 120);

  const referer = String(req.headers.referer || '').trim();
  if (referer) {
    try {
      return new URL(referer).hostname.slice(0, 120) || 'referral';
    } catch (_error) {
      return 'referral';
    }
  }

  return 'direct';
}

async function resolveCustomerType(req, userId) {
  const fromHeader = String(req.headers['x-customer-type'] || '').toLowerCase();
  if (fromHeader === 'new' || fromHeader === 'returning') return fromHeader;

  if (!userId) return 'new';
  const bookingCount = await Booking.countDocuments({ candidateId: userId });
  return bookingCount > 0 ? 'returning' : 'new';
}

function resolveActivityLabel(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return '';
  if (Object.values(ACTIVITY_LABELS).includes(value)) return value;
  if (ACTIVITY_LABEL_ALIASES[value]) return ACTIVITY_LABEL_ALIASES[value];
  if (ACTIVITY_LABELS[value]) return ACTIVITY_LABELS[value];
  return '';
}

async function writeActivityLog(req, activityLabel, userId = null) {
  try {
    if (!Object.values(ACTIVITY_LABELS).includes(activityLabel)) return;

    const excludedAdminEmail = String(process.env.ADMIN_EMAIL || 'admin@hireme.vn').toLowerCase();
    const requestUserEmail = String(req.user?.email || '').toLowerCase();
    if (requestUserEmail && requestUserEmail === excludedAdminEmail) return;

    if (userId) {
      const isSameUserAsRequest = req.user && String(req.user._id) === String(userId);
      if (!isSameUserAsRequest) {
        const user = await User.findById(userId).select('email').lean();
        const targetEmail = String(user?.email || '').toLowerCase();
        if (targetEmail && targetEmail === excludedAdminEmail) return;
      }
    }

    const customerType = await resolveCustomerType(req, userId);
    await ActivityLog.create({
      sessionId: normalizeCaseSessionId(req.headers['x-session-id']),
      activity: activityLabel,
      timestamp: new Date(),
      channel: resolveChannel(req),
      device: String(req.headers['x-device'] || detectDevice(req.get('user-agent'))).slice(0, 50) || 'desktop',
      customerType,
      userId
    });
  } catch (_error) {
    // Logging should never break auth/booking business APIs.
  }
}

async function seedExpertsIfEmpty() {
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@hireme.vn').toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || 'Admin@123';
  let adminUser = await User.findOne({ email: adminEmail });
  if (!adminUser) {
    const adminPasswordHash = await bcrypt.hash(adminPassword, 10);
    adminUser = await User.create({
      email: adminEmail,
      passwordHash: adminPasswordHash,
      fullName: 'Quản trị hệ thống',
      role: 'admin',
      isActive: true
    });
  } else if (adminUser.role !== 'admin') {
    adminUser.role = 'admin';
    adminUser.isActive = true;
    await adminUser.save();
  }

  const count = await ExpertProfile.countDocuments();
  if (count > 0) return;

  const defaultExperts = [
    { email: 'ha.hr@hireme.vn', fullName: 'Trần Thu Hà', title: 'HR Manager @ TechCorp', price: 350000 },
    { email: 'hoang.headhunter@hireme.vn', fullName: 'Lê Văn Hoàng', title: 'Senior IT Headhunter', price: 250000 }
  ];

  for (const item of defaultExperts) {
    let user = await User.findOne({ email: item.email });
    if (!user) {
      const passwordHash = await bcrypt.hash('Expert@123', 10);
      user = await User.create({
        email: item.email,
        passwordHash,
        fullName: item.fullName,
        role: 'expert'
      });
    }

    await ExpertProfile.create({
      userId: user._id,
      title: item.title,
      yearsExperience: 5,
      basePriceVnd: item.price,
      isAvailable: true,
      rating: 4.9,
      totalReviews: 128
    });
  }
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    mongoReady: isMongoReady,
    port: activePort
  });
});

app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  if (!isMongoReady) {
    return res.status(503).json({ message: 'Database đang kết nối lại. Vui lòng thử lại sau vài giây.' });
  }
  return next();
});

app.post('/api/activity-logs', async (req, res) => {
  try {
    const activityLabel = resolveActivityLabel(req.body?.activity || req.body?.activityKey);
    if (!activityLabel) {
      return res.status(400).json({ message: 'Activity không hợp lệ.' });
    }

    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (token) {
      try {
        const payload = jwt.verify(token, jwtSecret);
        const user = await User.findById(payload.sub);
        if (user && user.isActive) req.user = user;
      } catch (_error) {
        // Allow anonymous logging for unauthenticated UI events.
      }
    }

    await writeActivityLog(req, activityLabel, req.user?._id || null);
    return res.status(201).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Cannot create activity log.' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, fullName } = req.body;

    if (!email || !password || !fullName) {
      return res.status(400).json({ message: 'Thiếu thông tin đăng ký.' });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      await writeActivityLog(req, ACTIVITY_LABELS.register_failed, null);
      return res.status(400).json({ message: 'Email đã tồn tại.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({
      email: email.toLowerCase(),
      passwordHash,
      fullName,
      role: 'candidate'
    });

    const token = createToken(user);
    await writeActivityLog(req, ACTIVITY_LABELS.register_success, user._id);
    return res.status(201).json({
      token,
      user: {
        id: user._id,
        email: user.email,
        fullName: user.fullName,
        role: user.role
      }
    });
  } catch (error) {
    await writeActivityLog(req, ACTIVITY_LABELS.register_failed, null);
    return res.status(500).json({ message: error.message || 'Register failed.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'Thiếu email hoặc mật khẩu.' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      await writeActivityLog(req, ACTIVITY_LABELS.login_failed, null);
      return res.status(400).json({ message: 'Sai email hoặc mật khẩu.' });
    }
    if (!user.isActive) {
      return res.status(403).json({ message: 'Tài khoản của bạn đang bị khóa.' });
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      await writeActivityLog(req, ACTIVITY_LABELS.login_failed, user._id);
      return res.status(400).json({ message: 'Sai email hoặc mật khẩu.' });
    }

    const token = createToken(user);
    await writeActivityLog(req, ACTIVITY_LABELS.login, user._id);
    return res.json({
      token,
      user: {
        id: user._id,
        email: user.email,
        fullName: user.fullName,
        role: user.role
      }
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Login failed.' });
  }
});

app.post('/api/auth/logout', authMiddleware, async (req, res) => {
  try {
    await writeActivityLog(req, ACTIVITY_LABELS.logout, req.user._id);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Logout failed.' });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  return res.json({
    user: {
      id: req.user._id,
      email: req.user.email,
      fullName: req.user.fullName,
      role: req.user.role
    }
  });
});

app.get('/api/experts', async (_req, res) => {
  try {
    const experts = await ExpertProfile.find({ isAvailable: true })
      .select('userId title basePriceVnd')
      .populate({ path: 'userId', select: 'fullName isActive', options: { lean: true } })
      .sort({ basePriceVnd: 1 })
      .lean();

    return res.json({
      experts: experts
        .filter((item) => item.userId?.isActive !== false)
        .map((item) => ({
          id: item._id,
          fullName: item.userId?.fullName || 'Chuyên gia',
          title: item.title,
          priceVnd: item.basePriceVnd
        }))
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Cannot load experts.' });
  }
});

app.post('/api/bookings', authMiddleware, upload.single('cv'), async (req, res) => {
  try {
    const { bookingDate, startTime, priceVnd, expertId, cvOriginalName } = req.body;

    if (!req.file) {
      return res.status(400).json({ message: 'Bạn cần tải CV lên.' });
    }
    if (!bookingDate || !startTime || !priceVnd) {
      return res.status(400).json({ message: 'Thiếu thông tin lịch hẹn.' });
    }

    const optimizedUpload = await optimizeUploadedCvFile(req.file);

    const cvDoc = await CvFile.create({
      candidateId: req.user._id,
      originalFilename: String(cvOriginalName || req.file.originalname || 'CV.pdf').slice(0, 255),
      storageKey: optimizedUpload.storageKey,
      mimeType: optimizedUpload.mimeType,
      fileSizeBytes: optimizedUpload.fileSizeBytes
    });

    let expertObjectId = null;
    if (expertId && mongoose.Types.ObjectId.isValid(expertId)) {
      expertObjectId = new mongoose.Types.ObjectId(expertId);
    }

    const booking = await Booking.create({
      candidateId: req.user._id,
      expertId: expertObjectId,
      cvFileId: cvDoc._id,
      bookingDate,
      startTime,
      endTime: plus45Min(startTime),
      priceVnd: Number(priceVnd),
      status: 'confirmed',
      payment: {
        provider: 'bank_transfer_qr',
        status: 'paid',
        paidAt: new Date()
      }
    });

    await writeActivityLog(req, ACTIVITY_LABELS.booking_created, req.user._id);

    return res.status(201).json({
      booking: {
        id: booking._id,
        bookingDate: booking.bookingDate,
        bookingDateDisplay: formatDateDisplay(booking.bookingDate),
        startTime: booking.startTime,
        cvName: cvDoc.originalFilename
      }
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Cannot create booking.' });
  }
});

app.get('/api/bookings/me', authMiddleware, async (req, res) => {
  try {
    const bookings = await Booking.find({ candidateId: req.user._id })
      .select('bookingDate startTime status expertId cvFileId createdAt')
      .populate({
        path: 'expertId',
        select: 'userId',
        options: { lean: true },
        populate: { path: 'userId', select: 'fullName', options: { lean: true } }
      })
      .populate({ path: 'cvFileId', select: 'originalFilename', options: { lean: true } })
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      bookings: bookings.map((item) => ({
        id: item._id,
        bookingDate: item.bookingDate,
        bookingDateDisplay: formatDateDisplay(item.bookingDate),
        startTime: item.startTime,
        expertName: item.expertId?.userId?.fullName || 'Hệ thống phân công ngẫu nhiên',
        cvName: item.cvFileId?.originalFilename || 'CV.pdf',
        status: item.status
      }))
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Cannot load booking history.' });
  }
});

app.get('/api/admin/users', authMiddleware, adminOnly, async (_req, res) => {
  try {
    const users = await User.find({}).sort({ createdAt: -1 });
    return res.json({
      users: users.map((item) => ({
        id: item._id,
        email: item.email,
        fullName: item.fullName,
        role: item.role,
        isActive: item.isActive,
        createdAt: item.createdAt
      }))
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Cannot load users.' });
  }
});

app.patch('/api/admin/users/:userId/is-active', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { userId } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ message: 'isActive phải là true/false.' });
    }
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: 'User ID không hợp lệ.' });
    }
    if (String(req.user._id) === String(userId) && isActive === false) {
      return res.status(400).json({ message: 'Không thể tự khóa tài khoản admin đang đăng nhập.' });
    }

    const updated = await User.findByIdAndUpdate(
      userId,
      { isActive },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ message: 'Không tìm thấy user.' });
    }

    await writeActivityLog(req, ACTIVITY_LABELS.admin_user_status_updated, req.user._id);

    return res.json({
      user: {
        id: updated._id,
        email: updated.email,
        fullName: updated.fullName,
        role: updated.role,
        isActive: updated.isActive
      }
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Cannot update user status.' });
  }
});

app.get('/api/admin/experts', authMiddleware, adminOnly, async (_req, res) => {
  try {
    const experts = await ExpertProfile.find({})
      .populate('userId', 'email fullName role isActive')
      .sort({ createdAt: -1 });

    return res.json({
      experts: experts.map((item) => ({
        id: item._id,
        userId: item.userId?._id || null,
        email: item.userId?.email || '',
        fullName: item.userId?.fullName || 'Chuyên gia',
        title: item.title,
        bio: item.bio,
        yearsExperience: item.yearsExperience,
        basePriceVnd: item.basePriceVnd,
        avatarUrl: item.avatarUrl,
        isAvailable: item.isAvailable,
        userIsActive: item.userId?.isActive ?? true
      }))
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Cannot load expert list.' });
  }
});

app.post('/api/admin/experts', authMiddleware, adminOnly, async (req, res) => {
  try {
    const {
      email,
      fullName,
      password,
      title,
      bio,
      yearsExperience,
      basePriceVnd,
      avatarUrl,
      isAvailable
    } = req.body;

    if (!email || !fullName || !title || !basePriceVnd) {
      return res.status(400).json({ message: 'Thiếu thông tin bắt buộc để tạo expert.' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    let user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      const hash = await bcrypt.hash(String(password || 'Expert@123'), 10);
      user = await User.create({
        email: normalizedEmail,
        passwordHash: hash,
        fullName,
        role: 'expert',
        isActive: true
      });
    } else {
      user.fullName = fullName;
      user.role = 'expert';
      user.isActive = true;
      await user.save();
    }

    const existedProfile = await ExpertProfile.findOne({ userId: user._id });
    if (existedProfile) {
      return res.status(400).json({ message: 'User này đã có hồ sơ expert.' });
    }

    const expert = await ExpertProfile.create({
      userId: user._id,
      title,
      bio: bio || '',
      yearsExperience: Number(yearsExperience || 0),
      basePriceVnd: Number(basePriceVnd),
      avatarUrl: avatarUrl || '',
      isAvailable: isAvailable !== false
    });

    await writeActivityLog(req, ACTIVITY_LABELS.admin_expert_created, req.user._id);

    return res.status(201).json({
      expert: {
        id: expert._id,
        userId: user._id,
        email: user.email,
        fullName: user.fullName,
        title: expert.title,
        bio: expert.bio,
        yearsExperience: expert.yearsExperience,
        basePriceVnd: expert.basePriceVnd,
        avatarUrl: expert.avatarUrl,
        isAvailable: expert.isAvailable
      }
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Cannot create expert.' });
  }
});

app.put('/api/admin/experts/:expertId', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { expertId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(expertId)) {
      return res.status(400).json({ message: 'Expert ID không hợp lệ.' });
    }

    const {
      fullName,
      title,
      bio,
      yearsExperience,
      basePriceVnd,
      avatarUrl,
      isAvailable,
      userIsActive
    } = req.body;

    const expert = await ExpertProfile.findById(expertId);
    if (!expert) {
      return res.status(404).json({ message: 'Không tìm thấy expert.' });
    }

    if (typeof title === 'string' && title.trim()) expert.title = title.trim();
    if (typeof bio === 'string') expert.bio = bio;
    if (typeof yearsExperience !== 'undefined') expert.yearsExperience = Number(yearsExperience || 0);
    if (typeof basePriceVnd !== 'undefined') expert.basePriceVnd = Number(basePriceVnd || 0);
    if (typeof avatarUrl === 'string') expert.avatarUrl = avatarUrl;
    if (typeof isAvailable === 'boolean') expert.isAvailable = isAvailable;
    await expert.save();

    const user = await User.findById(expert.userId);
    if (user) {
      if (typeof fullName === 'string' && fullName.trim()) user.fullName = fullName.trim();
      user.role = 'expert';
      if (typeof userIsActive === 'boolean') user.isActive = userIsActive;
      await user.save();
    }

    await writeActivityLog(req, ACTIVITY_LABELS.admin_expert_updated, req.user._id);

    return res.json({ message: 'Cập nhật expert thành công.' });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Cannot update expert.' });
  }
});

app.delete('/api/admin/experts/:expertId', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { expertId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(expertId)) {
      return res.status(400).json({ message: 'Expert ID không hợp lệ.' });
    }

    const expert = await ExpertProfile.findById(expertId);
    if (!expert) {
      return res.status(404).json({ message: 'Không tìm thấy expert.' });
    }

    await Booking.updateMany({ expertId: expert._id }, { $set: { expertId: null } });
    await ExpertProfile.deleteOne({ _id: expert._id });
    await User.updateOne({ _id: expert.userId }, { $set: { role: 'candidate' } });

    await writeActivityLog(req, ACTIVITY_LABELS.admin_expert_deleted, req.user._id);

    return res.json({ message: 'Đã xóa expert.' });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Cannot delete expert.' });
  }
});

app.get('/api/admin/bookings', authMiddleware, adminOnly, async (_req, res) => {
  try {
    const bookings = await Booking.find({})
      .populate('candidateId', 'fullName email isActive')
      .populate({
        path: 'expertId',
        populate: { path: 'userId', select: 'fullName email isActive' }
      })
      .populate('cvFileId', 'originalFilename')
      .sort({ createdAt: -1 });

    return res.json({
      bookings: bookings.map((item) => ({
        id: item._id,
        candidateName: item.candidateId?.fullName || 'Ứng viên',
        candidateEmail: item.candidateId?.email || '',
        expertId: item.expertId?._id || null,
        expertName: item.expertId?.userId?.fullName || 'Chưa phân công',
        bookingDate: item.bookingDate,
        bookingDateDisplay: formatDateDisplay(item.bookingDate),
        startTime: item.startTime,
        endTime: item.endTime,
        priceVnd: item.priceVnd,
        status: item.status,
        cvName: item.cvFileId?.originalFilename || 'CV.pdf',
        createdAt: item.createdAt
      }))
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Cannot load bookings.' });
  }
});

app.patch('/api/admin/bookings/:bookingId', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { bookingId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ message: 'Booking ID không hợp lệ.' });
    }

    const allowedStatuses = ['pending_payment', 'confirmed', 'in_room', 'completed', 'cancelled', 'no_show'];
    const { status, bookingDate, startTime, priceVnd, expertId } = req.body;

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ message: 'Không tìm thấy lịch hẹn.' });
    }

    if (typeof status === 'string') {
      if (!allowedStatuses.includes(status)) {
        return res.status(400).json({ message: 'Trạng thái lịch hẹn không hợp lệ.' });
      }
      booking.status = status;
    }

    if (typeof bookingDate === 'string' && bookingDate.trim()) {
      booking.bookingDate = bookingDate;
    }

    if (typeof startTime === 'string' && startTime.trim()) {
      booking.startTime = startTime;
      booking.endTime = plus45Min(startTime);
    }

    if (typeof priceVnd !== 'undefined') {
      booking.priceVnd = Number(priceVnd || 0);
    }

    if (typeof expertId !== 'undefined') {
      if (!expertId) {
        booking.expertId = null;
      } else if (!mongoose.Types.ObjectId.isValid(expertId)) {
        return res.status(400).json({ message: 'Expert ID không hợp lệ.' });
      } else {
        const expert = await ExpertProfile.findById(expertId);
        if (!expert) {
          return res.status(404).json({ message: 'Không tìm thấy expert được chọn.' });
        }
        booking.expertId = expert._id;
      }
    }

    await booking.save();
    await writeActivityLog(req, ACTIVITY_LABELS.admin_booking_updated, req.user._id);
    return res.json({ message: 'Cập nhật lịch hẹn thành công.' });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Cannot update booking.' });
  }
});

app.delete('/api/admin/bookings/:bookingId', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { bookingId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ message: 'Booking ID không hợp lệ.' });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ message: 'Không tìm thấy lịch hẹn.' });
    }

    await Booking.deleteOne({ _id: booking._id });
    await writeActivityLog(req, ACTIVITY_LABELS.admin_booking_deleted, req.user._id);
    return res.json({ message: 'Đã xóa lịch hẹn.' });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Cannot delete booking.' });
  }
});

app.get('/api/admin/activity-logs', authMiddleware, adminOnly, async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page, 1, 1000000);
    const limit = parsePositiveInt(req.query.limit, 30, 500);
    const activity = String(req.query.activity || '').trim();
    const channel = String(req.query.channel || '').trim();
    const device = String(req.query.device || '').trim();
    const customerType = String(req.query.customerType || '').trim();
    const sessionId = String(req.query.sessionId || '').trim();
    const from = parseDateBoundary(req.query.from, false);
    const to = parseDateBoundary(req.query.to, true);

    const query = {};
    if (activity) query.activity = activity;
    if (channel) query.channel = channel;
    if (device) query.device = device;
    if (customerType) query.customerType = customerType;
    if (sessionId) query.sessionId = sessionId;
    if (from || to) {
      query.timestamp = {};
      if (from) query.timestamp.$gte = from;
      if (to) query.timestamp.$lte = to;
    }

    const [logs, total] = await Promise.all([
      ActivityLog.find(query)
        .populate('userId', 'fullName email role')
        .sort({ timestamp: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      ActivityLog.countDocuments(query)
    ]);

    return res.json({
      logs: logs.map((item) => ({
        id: item._id,
        sessionId: item.sessionId,
        activity: item.activity,
        timestamp: item.timestamp,
        timestampIso: toIsoDateTime(item.timestamp),
        channel: item.channel,
        device: item.device,
        customerType: item.customerType,
        user: item.userId
          ? {
              id: item.userId._id,
              fullName: item.userId.fullName,
              email: item.userId.email,
              role: item.userId.role
            }
          : null
      })),
      paging: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit))
      }
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Cannot load activity logs.' });
  }
});

app.get('/api/admin/activity-logs/export', authMiddleware, adminOnly, async (req, res) => {
  try {
    const activity = String(req.query.activity || '').trim();
    const channel = String(req.query.channel || '').trim();
    const device = String(req.query.device || '').trim();
    const customerType = String(req.query.customerType || '').trim();
    const sessionId = String(req.query.sessionId || '').trim();
    const from = parseDateBoundary(req.query.from, false);
    const to = parseDateBoundary(req.query.to, true);

    const query = {};
    if (activity) query.activity = activity;
    if (channel) query.channel = channel;
    if (device) query.device = device;
    if (customerType) query.customerType = customerType;
    if (sessionId) query.sessionId = sessionId;
    if (from || to) {
      query.timestamp = {};
      if (from) query.timestamp.$gte = from;
      if (to) query.timestamp.$lte = to;
    }

    const logs = await ActivityLog.find(query)
      .populate('userId', 'fullName email role')
      .sort({ timestamp: -1 })
      .lean();

    const rows = logs.map((item, index) => ({
      STT: index + 1,
      SessionID: item.sessionId,
      Activity: item.activity,
      TimestampISO: toIsoDateTime(item.timestamp),
      Channel: item.channel,
      Device: item.device,
      CustomerType: item.customerType,
      UserFullName: item.userId?.fullName || '',
      UserEmail: item.userId?.email || '',
      UserRole: item.userId?.role || ''
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'CheckLogs');

    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const filename = `checklogs-${stamp}.xlsx`;

    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await writeActivityLog(req, ACTIVITY_LABELS.admin_logs_exported, req.user._id);
    return res.send(buffer);
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Cannot export activity logs.' });
  }
});

async function start() {
  const basePort = Number(port) || 3000;
  const candidatePorts = [basePort, basePort + 1, basePort + 2];

  const bindServer = async () => {
    for (const candidate of candidatePorts) {
      const started = await new Promise((resolve) => {
        let settled = false;
        const done = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };

        const server = app.listen(candidate, () => {
          activePort = candidate;
          console.log(`HireMe MongoDB API running on http://localhost:${candidate}`);
          done(true);
        });

        server.once('error', (error) => {
          if (error.code === 'EADDRINUSE') {
            console.warn(`Port ${candidate} is busy, trying next port...`);
            done(false);
            return;
          }
          console.error('Server listen failed:', error.message);
          process.exit(1);
        });

        setTimeout(() => {
          if (settled) return;
          console.warn(`Port ${candidate} did not confirm listening in time, trying next port...`);
          server.close(() => done(false));
        }, 3000);
      });

      if (started) return;
    }

    console.error('No available port in range', candidatePorts.join(', '));
    process.exit(1);
  };

  await bindServer();

  mongoose.connection.on('connected', () => {
    isMongoReady = true;
    console.log('MongoDB connected.');
  });

  mongoose.connection.on('disconnected', () => {
    isMongoReady = false;
    console.warn('MongoDB disconnected. Retrying connection...');
  });

  mongoose.connection.on('error', (error) => {
    isMongoReady = false;
    console.error('MongoDB error:', error.message);
  });

  while (true) {
    try {
      if (!mongoose.connection.readyState) {
        await mongoose.connect(mongoUri, {
          serverSelectionTimeoutMS: 10000,
          connectTimeoutMS: 10000
        });
      }

      isMongoReady = true;
      if (!expertsSeeded) {
        await seedExpertsIfEmpty();
        expertsSeeded = true;
      }
      break;
    } catch (error) {
      isMongoReady = false;
      console.error('MongoDB connection failed:', error.message);
      console.error('Retrying MongoDB connection in 5s...');
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

start();
