// Create a registration link for a counter phone, from the command line.
//
//   node scripts/counter-invite.js "Father's phone"
//
// The dashboard does this too. This exists because the dashboard needs a login
// and a browser, and the one time you most need to register a device is when
// something else is broken.

require("dotenv").config();
const mongoose = require("mongoose");
const crypto = require("crypto");
const { CounterDevice } = require("../models/counterModels");

const label = process.argv.slice(2).join(" ").trim() || "Counter phone";
const base = (process.env.PUBLIC_BASE_URL || "https://backend.sajanshreegarments.in").replace(/\/+$/, "");

(async () => {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set. Run this from the backend folder, with its .env in place.");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);

  const code = crypto.randomBytes(32).toString("hex");
  await CounterDevice.create({
    label,
    inviteCode: code,
    inviteExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
  });

  console.log(`\n  ${label}\n`);
  console.log(`  ${base}/slips/claim/${code}\n`);
  console.log("  Open it on that phone once, within 30 minutes. It works a single time.");
  console.log("  After that the phone opens " + base + "/slips with nothing to type.\n");

  await mongoose.disconnect();
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
