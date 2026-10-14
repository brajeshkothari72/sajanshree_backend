// Auth for the dispatch-slip page.
//
// Deliberately NOT the JWT `protect` middleware, and deliberately not a login.
// The person using this is at a counter with a parcel in one hand; a password
// screen would mean the slip never gets photographed. So the DEVICE is trusted
// instead of the person: registered once from an invite the owner creates, and
// revocable the moment a phone goes missing.
//
// What this grants is intentionally narrow. A device may list recent bills,
// attach a photo to one, and ask for one to be sent. It may not touch orders,
// customers, users or anything else. A phone left on a counter must not be a
// key to the business.

const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const User = require("../models/userModel");
const { CounterDevice } = require("../models/counterModels");

const COOKIE_NAME = "ssg_counter";
// Long, because re-registering a phone is a trip to the shop. The cookie is
// revocable from the dashboard, which is the control that actually matters.
const COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;

// One cookie, read by hand. cookie-parser would be a dependency for six lines,
// and this is the only cookie the API uses.
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return "";
}

function newSecret() {
  return crypto.randomBytes(32).toString("hex");
}

function setDeviceCookie(res, token) {
  const bits = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${Math.floor(COOKIE_MAX_AGE_MS / 1000)}`,
    // httpOnly: page scripts never need to read it, and not exposing it to
    // JavaScript removes a whole class of ways for it to escape.
    "HttpOnly",
    // Lax, not Strict: the device arrives by following the invite link, and
    // Strict would withhold the cookie on exactly that first navigation.
    "SameSite=Lax",
  ];
  // Secure in production only, so this still works over plain http on the till
  // during setup.
  if (process.env.NODE_ENV === "production") bits.push("Secure");
  res.setHeader("Set-Cookie", bits.join("; "));
}

function clearDeviceCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}

async function counterAuth(req, res, next) {
  // The owner, from the admin dashboard, authenticates the way everywhere
  // else in that app does - a JWT, not a device cookie. This lets the owner
  // use bills/upload/send from the dashboard without that browser needing
  // to be registered as a device of its own. It also has to work cross-origin
  // (the admin dashboard calling this API from a different host), where a
  // cookie set here would not be sent along anyway.
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    try {
      const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select("-password");
      if (user) {
        req.counterDevice = null; // owner, not a registered phone
        return next();
      }
    } catch {
      // Not a valid admin token. Fall through to the device-cookie check -
      // a stale or absent token here must not block a request that is
      // actually carrying a good device cookie instead.
    }
  }

  const token = readCookie(req, COOKIE_NAME);
  if (!token) {
    return res.status(401).json({ message: "This device is not registered.", needsInvite: true });
  }

  const device = await CounterDevice.findOne({ deviceToken: token });
  if (!device || !device.isUsable()) {
    // A revoked phone should stop working immediately and visibly, not drift on
    // with stale access until the cookie expires.
    clearDeviceCookie(res);
    return res.status(401).json({ message: "This device is no longer allowed.", needsInvite: true });
  }

  // Fire-and-forget: "when did the counter phone last use this" is worth having,
  // and is never worth delaying a request for.
  CounterDevice.updateOne({ _id: device._id }, { $set: { lastSeenAt: new Date() } }).catch(() => {});

  req.counterDevice = device;
  return next();
}

module.exports = { counterAuth, setDeviceCookie, clearDeviceCookie, newSecret, COOKIE_NAME };
