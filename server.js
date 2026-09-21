require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const swaggerUi = require("swagger-ui-express");
const YAML = require("yamljs");
const path = require("path");

const app = express();

// Middleware
app.use(express.json()); // Parses incoming JSON requests
// CORS configuration
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "https://admin.sajanshreegarments.in",
];

// Any subdomain of our own domain. The dashboard has already moved hosts twice,
// and each move broke every API call with a CORS error that reads like an auth
// or network fault — this stops the next move needing a backend redeploy.
const ALLOWED_ORIGIN_PATTERN = /^https:\/\/([a-z0-9-]+\.)*sajanshreegarments\.in$/i;

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    // Allow all localhost ports
    if (/^http:\/\/localhost:\d+$/.test(origin)) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || ALLOWED_ORIGIN_PATTERN.test(origin)) {
      return callback(null, true);
    }
    // Deny by returning false rather than an Error: an Error here becomes a 500
    // from the error handler, which looks like the API is broken instead of
    // saying the origin was refused.
    console.warn(`🚫 CORS: refused origin ${origin}`);
    return callback(null, false);
  },
  credentials: true,
};

app.use(cors(corsOptions)); // Enables CORS for frontend communication
// Explicitly handle preflight OPTIONS requests for all routes
app.options("*", cors(corsOptions));
app.use(morgan("dev")); // Logs requests for debugging

// Swagger UI
const swaggerDocument = YAML.load(path.join(__dirname, "swagger.yaml"));
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Sample route
app.get("/", (req, res) => {
  res.send("Sajan Shree Order Management API is running...");
});

// Port Configuration
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const Order = require("./models/orderModel");
const User = require("./models/userModel");

// Test MongoDB connection with a sample query
const testDB = async () => {
  try {
    const orders = await Order.find();
    console.log("Orders in database:", orders.length);
  } catch (error) {
    console.error("Database test failed:", error);
  }
};

testDB();

const orderRoutes = require("./routes/orderRoutes");
const userRoutes = require("./routes/userRoutes");
const productRoutes = require("./routes/productRoutes");
const customerRoutes = require("./routes/customerRoutes");
const tallyRoutes = require("./routes/tallyRoutes");

// Use Routes
app.use("/api/orders", orderRoutes);
app.use("/api/users", userRoutes);
app.use("/api/products", productRoutes);
app.use("/api/customers", customerRoutes);
// Called by the TallyPrime companion service on the shop PC. Not a browser
// origin, so the CORS allowlist above doesn't apply to it.
app.use("/api/tally", tallyRoutes);

const mongoose = require("mongoose");

// Keep retrying rather than exiting.
//
// process.exit(1) here used to turn any database problem into a crash loop: the
// server binds its port, the host marks it healthy, then ~50s later the process
// dies and gets restarted, forever. On Render that shows as a deploy stuck "in
// progress" rather than a failure, which is a great deal harder to diagnose than
// a service that stays up and says loudly what is wrong.
//
// A wrong MONGO_URI now surfaces as failing requests plus this log, which is the
// tradeoff: noisier in production, but recoverable without a redeploy once the
// database comes back or a credential is corrected.
const CONNECT_RETRY_MS = 10000;

const connectDB = async () => {
  if (!process.env.MONGO_URI) {
    console.error("❌ MONGO_URI is not set — the API will run but every query will fail.");
    return;
  }
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ MongoDB Connected Successfully");
  } catch (error) {
    console.error(
      `❌ MongoDB Connection Error: ${error.message} — retrying in ${CONNECT_RETRY_MS / 1000}s`
    );
    setTimeout(connectDB, CONNECT_RETRY_MS).unref();
  }
};

connectDB();

const errorHandler = require("./middleware/errorMiddleware");

// Use Routes
app.use("/api/orders", orderRoutes);
app.use("/api/users", userRoutes);

// Error Handling Middleware (should be after routes)
app.use(errorHandler);

require("./utils/cronJobs"); // Import and start cron jobs
