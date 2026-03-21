# HireMe + MongoDB Setup

## 1) Prepare environment

1. Copy `.env.example` to `.env`
2. Update values in `.env`:

```
PORT=3000
MONGODB_URI=mongodb://127.0.0.1:27017/hireme
JWT_SECRET=your_long_random_secret
```

## 2) Run backend API

```bash
npm install
npm run start
```

API base URL: `http://localhost:3000/api`

## 3) Run frontend

Open `index.html` in browser. Frontend already calls MongoDB API via:

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/experts`
- `POST /api/bookings` (multipart upload CV)
- `GET /api/bookings/me`

## 4) Seed experts

Server auto seeds 2 experts if collection is empty:

- Trần Thu Hà
- Lê Văn Hoàng

## 5) Data storage

- Uploaded CV files are saved in `uploads/`
- MongoDB collections are managed by Mongoose models in `server.js`

## 6) Troubleshooting startup

If `npm run start` does not show `HireMe MongoDB API running...`, the server is likely stuck connecting to MongoDB.

- Verify `.env` has a valid `MONGODB_URI` copied from MongoDB Atlas Connect dialog.
- If DNS lookup for your cluster host returns `No answer`, your cluster host is wrong, deleted, or blocked by network DNS.
- Ensure Atlas allows your current IP in Network Access.
- Retry with a local URI for testing:

```env
MONGODB_URI=mongodb://127.0.0.1:27017/hireme
```
