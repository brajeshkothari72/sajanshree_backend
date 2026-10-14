const express = require("express");
const protect = require("../middleware/authMiddleware");
const tallyAuth = require("../middleware/tallyAuthMiddleware");
const { counterAuth } = require("../middleware/counterAuthMiddleware");
const counter = require("../controllers/counterController");

const router = express.Router();

// Voucher numbers carry a slash - "2026-27/441" - so they travel as ?v=, never
// as a path segment. As a path they arrive either split in two or rejected by
// the proxy before Express sees them.

// --- the owner, on a JWT session ---------------------------------------------
router.post("/invites", protect, counter.createInvite);
router.get("/devices", protect, counter.listDevices);
router.post("/devices/:id/revoke", protect, counter.revokeDevice);

// --- a registered phone, on its cookie ---------------------------------------
router.get("/bills", counterAuth, counter.bills);
router.post("/slips", counterAuth, counter.uploadSlip);
router.get("/slip-image", counterAuth, counter.slipImage);
router.post("/send", counterAuth, counter.requestSend);
router.get("/send-status", counterAuth, counter.sendStatus);

// --- the till companion, on the shared key -----------------------------------
router.post("/snapshot", tallyAuth, counter.putSnapshot);
router.get("/commands", tallyAuth, counter.claimCommands);
router.post("/commands/:id", tallyAuth, counter.completeCommand);

module.exports = router;
