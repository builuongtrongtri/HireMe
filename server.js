const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

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

const activityLogSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, index: true },
    activity: { type: String, required: true, trim: true, index: true },
    timestamp: { type: Date, default: Date.now, index: true },
    channel: { type: String, default: 'direct', index: true },
    device: { type: String, default: 'unknown' },
    customerType: { type: String, enum: ['new', 'returning'], default: 'new', index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    method: { type: String, default: '' },
    path: { type: String, default: '' },
    statusCode: { type: Number, default: 0 },
    latencyMs: { type: Number, default: 0 },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null }
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
      return res.status(403).json({ message: 'Tài khoản của bạn đang bị khóa.' });
    }

    req.user = user;
    next();
  } catch (_error) {
    return res.status(401).json({ message: 'Token không hợp lệ hoặc đã hết hạn.' });
  }
}

async function optionalAuthMiddleware(req, _res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return next();

    const payload = jwt.verify(token, jwtSecret);
    const user = await User.findById(payload.sub);
    if (user && user.isActive) {
      req.user = user;
    }
  } catch (_error) {
    // optional auth should never block request
  }
  return next();
}

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Bạn không có quyền truy cập chức năng này.' });
  }
  return next();
}

function inferDevice(userAgent = '') {
  const ua = String(userAgent).toLowerCase();
  if (!ua) return 'unknown';
  if (ua.includes('mobile')) return 'mobile';
  if (ua.includes('tablet') || ua.includes('ipad')) return 'tablet';
  return 'desktop';
}

async function resolveCustomerType(req) {
  if (req.user?.role === 'candidate') {
    const hadBooking = await Booking.exists({ candidateId: req.user._id });
    return hadBooking ? 'returning' : 'new';
  }

  const provided = String(req.headers['x-customer-type'] || '').toLowerCase();
  if (provided === 'returning') return 'returning';
  return 'new';
}

async function writeActivityLog(req, payload = {}) {
  try {
    const sessionId = String(req.headers['x-session-id'] || payload.sessionId || '').trim() || `anon-${Date.now()}`;
    const channel = String(req.headers['x-channel'] || payload.channel || req.get('origin') || 'direct').slice(0, 120);
    const device = String(req.headers['x-device'] || payload.device || inferDevice(req.get('user-agent'))).slice(0, 80);
    const customerType = payload.customerType || await resolveCustomerType(req);

    await ActivityLog.create({
      sessionId,
      activity: payload.activity || `${req.method} ${req.path}`,
      timestamp: payload.timestamp || new Date(),
      channel,
      device,
      customerType,
      userId: req.user?._id || null,
      method: req.method,
      path: req.path,
      statusCode: payload.statusCode || 0,
      latencyMs: payload.latencyMs || 0,
      metadata: payload.metadata || null
    });
  } catch (_error) {
    // logging must never break business APIs
  }
}

app.use('/api', optionalAuthMiddleware, (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path === '/health' || req.path === '/activity-logs' || req.path.startsWith('/admin/activity-logs')) {
      return;
    }

    void writeActivityLog(req, {
      activity: `${req.method} ${req.path}`,
      statusCode: res.statusCode,
      latencyMs: Date.now() - start
    });
  });

  next();
});

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
  res.json({ ok: true, mongoReady: isMongoReady, port: activePort });
});

app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  if (!isMongoReady) {
    return res.status(503).json({ message: 'Database đang kết nối lại. Vui lòng thử lại sau vài giây.' });
  }
  return next();
});

app.post('/api/activity-logs', optionalAuthMiddleware, async (req, res) => {
  try {
    const { activity, timestamp, channel, device, customerType, metadata, sessionId } = req.body || {};

    if (!activity || !String(activity).trim()) {
      return res.status(400).json({ message: 'Thiếu activity.' });
    }

    await writeActivityLog(req, {
      activity: String(activity).trim(),
      timestamp: timestamp ? new Date(timestamp) : new Date(),
      channel,
      device,
      customerType: customerType === 'returning' ? 'returning' : 'new',
      metadata: metadata || null,
      sessionId,
      statusCode: 200
    });

    return res.status(201).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Cannot write activity log.' });
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
      return res.status(400).json({ message: 'Sai email hoặc mật khẩu.' });
    }
    if (!user.isActive) {
      return res.status(403).json({ message: 'Tài khoản của bạn đang bị khóa.' });
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      return res.status(400).json({ message: 'Sai email hoặc mật khẩu.' });
    }

    const token = createToken(user);
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
    const { bookingDate, startTime, priceVnd, expertId } = req.body;

    if (!req.file) {
      return res.status(400).json({ message: 'Bạn cần tải CV lên.' });
    }
    if (!bookingDate || !startTime || !priceVnd) {
      return res.status(400).json({ message: 'Thiếu thông tin lịch hẹn.' });
    }

    const cvDoc = await CvFile.create({
      candidateId: req.user._id,
      originalFilename: req.file.originalname,
      storageKey: req.file.filename,
      mimeType: req.file.mimetype || 'application/pdf',
      fileSizeBytes: req.file.size
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

app.get('/api/admin/activity-logs', authMiddleware, adminOnly, async (req, res) => {
  try {
    const {
      from,
      to,
      activity,
      channel,
      customerType,
      page = 1,
      limit = 50
    } = req.query;

    const filter = {};
    if (from || to) {
      filter.timestamp = {};
      if (from) filter.timestamp.$gte = new Date(from);
      if (to) filter.timestamp.$lte = new Date(to);
    }
    if (activity) filter.activity = new RegExp(String(activity), 'i');
    if (channel) filter.channel = new RegExp(String(channel), 'i');
    if (customerType && ['new', 'returning'].includes(String(customerType))) {
      filter.customerType = String(customerType);
    }

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(500, Math.max(10, Number(limit) || 50));

    const [total, logs] = await Promise.all([
      ActivityLog.countDocuments(filter),
      ActivityLog.find(filter)
        .select('sessionId activity timestamp channel device customerType method path statusCode latencyMs')
        .sort({ timestamp: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean()
    ]);

    return res.json({
      total,
      page: pageNum,
      limit: limitNum,
      logs: logs.map((item) => ({
        id: item._id,
        sessionId: item.sessionId,
        activity: item.activity,
        timestamp: item.timestamp,
        channel: item.channel,
        device: item.device,
        customerType: item.customerType,
        method: item.method,
        path: item.path,
        statusCode: item.statusCode,
        latencyMs: item.latencyMs
      }))
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Cannot load activity logs.' });
  }
});

app.get('/api/admin/activity-logs/export', authMiddleware, adminOnly, async (req, res) => {
  try {
    const xlsx = require('xlsx');
    const { from, to, activity, channel, customerType } = req.query;
    const filter = {};
    if (from || to) {
      filter.timestamp = {};
      if (from) filter.timestamp.$gte = new Date(from);
      if (to) filter.timestamp.$lte = new Date(to);
    }
    if (activity) filter.activity = new RegExp(String(activity), 'i');
    if (channel) filter.channel = new RegExp(String(channel), 'i');
    if (customerType && ['new', 'returning'].includes(String(customerType))) {
      filter.customerType = String(customerType);
    }

    const logs = await ActivityLog.find(filter)
      .select('sessionId activity timestamp channel device customerType method path statusCode latencyMs')
      .sort({ timestamp: -1 })
      .limit(50000)
      .lean();

    const rows = logs.map((item) => ({
      'Session ID': item.sessionId,
      Activity: item.activity,
      Timestamp: item.timestamp,
      Channel: item.channel,
      Device: item.device,
      'Customer Type': item.customerType,
      Method: item.method,
      Path: item.path,
      'Status Code': item.statusCode,
      'Latency (ms)': item.latencyMs
    }));

    const workbook = xlsx.utils.book_new();
    const worksheet = xlsx.utils.json_to_sheet(rows);
    xlsx.utils.book_append_sheet(workbook, worksheet, 'ActivityLogs');
    const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="activity-logs-${Date.now()}.xlsx"`);
    return res.send(buffer);
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Cannot export activity logs.' });
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
    return res.json({ message: 'Đã xóa lịch hẹn.' });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Cannot delete booking.' });
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
