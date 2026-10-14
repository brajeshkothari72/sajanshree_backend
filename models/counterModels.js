// The counter: the dispatch-slip page the shop floor uses from a phone.
//
// Four small collections, kept in one file because they are one feature and
// four files of fifteen lines each would be filing, not structure.
//
// The shape exists because of one constraint: the person using this will not log
// in. He opens a bookmark and it works. So a device is trusted instead of a
// person — registered once from an invite the owner creates, revocable, and
// scoped to this page alone.

const mongoose = require("mongoose");

// A phone (or the till's own browser) allowed to use the slip page.
//
// Two states in one document rather than two collections: an unclaimed invite,
// and the device that claimed it. They are the same thing at different points in
// its life, and splitting them would mean reconciling two records to answer "who
// can get in".
const counterDeviceSchema = new mongoose.Schema(
  {
    label: { type: String, required: true },

    // Set when the owner creates the invite, cleared the moment it is used.
    // Single-use and short-lived: a link that stays valid is a password that
    // nobody remembers writing down.
    inviteCode: { type: String, unique: true, sparse: true },
    inviteExpiresAt: Date,

    // What the phone actually carries, in an httpOnly cookie. Never appears in
    // a URL, so it cannot leak through browser history, a shared screenshot or
    // a Referer header the way the old ?k= token could.
    deviceToken: { type: String, unique: true, sparse: true },

    claimedAt: Date,
    lastSeenAt: Date,
    userAgent: String,

    // Revoked rather than deleted: "this phone was lost on the 14th" is worth
    // being able to answer later.
    revokedAt: Date,
  },
  { timestamps: true }
);

counterDeviceSchema.methods.isUsable = function isUsable() {
  return Boolean(this.deviceToken) && !this.revokedAt;
};

// A photo of a dispatch slip, waiting to be attached to its invoice.
//
// Kept here rather than relayed down to the till, because the backend is where
// the PDF is built. The till never needs to see it.
const dispatchSlipSchema = new mongoose.Schema(
  {
    voucherNumber: { type: String, required: true, unique: true },
    // The image itself. ~300 KB after the page scales it down, well inside
    // MongoDB's 16 MB document limit, and it saves a round trip to Cloudinary
    // for something that is read once and then finished with.
    imageBase64: { type: String, required: true },
    contentType: { type: String, default: "image/jpeg" },
    uploadedByDevice: { type: mongoose.Schema.Types.ObjectId, ref: "CounterDevice" },
    // Set when an invoice has actually carried it, so the page can say "sent"
    // rather than "waiting" without guessing.
    usedAt: Date,
  },
  { timestamps: true }
);

// Work for the till to do, which it collects by asking.
//
// This is the whole reason the system works from outside the shop: nothing has
// to reach IN to the till. It polls, so there is no port to open, no address to
// keep fixed, and the shop router needs no configuration at all.
const tillCommandSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["send"], required: true },
    voucherNumber: { type: String, required: true },
    partyLedgerName: String,
    status: {
      type: String,
      enum: ["pending", "claimed", "done", "failed"],
      default: "pending",
      index: true,
    },
    claimedAt: Date,
    completedAt: Date,
    error: String,
    requestedByDevice: { type: mongoose.Schema.Types.ObjectId, ref: "CounterDevice" },
  },
  { timestamps: true }
);

// The bill list, as the till last saw it.
//
// One document, overwritten. The phone reads this instead of Tally, which is
// what lets the page still be useful when the till is switched off — it shows
// the last known bills, with the time they were read, rather than an empty
// screen and no explanation.
const tillSnapshotSchema = new mongoose.Schema(
  {
    key: { type: String, default: "bills", unique: true },
    bills: { type: Array, default: [] },
    at: Date,
  },
  { timestamps: true }
);

module.exports = {
  CounterDevice: mongoose.model("CounterDevice", counterDeviceSchema),
  DispatchSlip: mongoose.model("DispatchSlip", dispatchSlipSchema),
  TillCommand: mongoose.model("TillCommand", tillCommandSchema),
  TillSnapshot: mongoose.model("TillSnapshot", tillSnapshotSchema),
};
