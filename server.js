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

const User = mongoose.model('User', userSchema);
const ExpertProfile = mongoose.model('ExpertProfile', expertProfileSchema);
const CvFile = mongoose.model('CvFile', cvFileSchema);
const Booking = mongoose.model('Booking', bookingSchema);

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

    req.user = user;
    next();
  } catch (_error) {
    return res.status(401).json({ message: 'Token không hợp lệ hoặc đã hết hạn.' });
  }
}

async function seedExpertsIfEmpty() {
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
  res.json({ ok: true });
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
      .populate('userId', 'fullName')
      .sort({ basePriceVnd: 1 });

    return res.json({
      experts: experts.map((item) => ({
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
      .populate({
        path: 'expertId',
        populate: { path: 'userId', select: 'fullName' }
      })
      .populate('cvFileId', 'originalFilename')
      .sort({ createdAt: -1 });

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

async function start() {
  try {
    const connectPromise = mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000
    });

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('MongoDB connection timeout after 12s.'));
      }, 12000);
    });

    await Promise.race([connectPromise, timeoutPromise]);
    await seedExpertsIfEmpty();
    app.listen(port, () => {
      console.log(`HireMe MongoDB API running on http://localhost:${port}`);
    });
  } catch (error) {
    console.error('Server startup failed:', error.message);
    console.error('MongoDB connection check: verify MONGODB_URI in .env and ensure the MongoDB host is reachable.');
    process.exit(1);
  }
}

start();
