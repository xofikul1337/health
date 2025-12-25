// api/requireSupabaseAuth.js
const jwt = require("jsonwebtoken");

/**
 * Verifies Supabase access_token (JWT) from:
 * Authorization: Bearer <token>
 *
 * Sets:
 *   req.auth = { uid, email, role, raw }
 */
module.exports = function requireSupabaseAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    const token = match?.[1];

    if (!token) {
      return res.status(401).json({ error: "Missing Authorization Bearer token" });
    }

    const secret = process.env.SUPABASE_JWT_SECRET;
    if (!secret) {
      return res.status(500).json({ error: "Server missing SUPABASE_JWT_SECRET" });
    }

    const decoded = jwt.verify(token, secret, {
      algorithms: ["HS256"], // Supabase legacy JWT secret flow
    });

    // Supabase access token usually has:
    // sub = user id, email, role=authenticated
    req.auth = {
      uid: decoded.sub || "",
      email: decoded.email || "",
      role: decoded.role || "",
      raw: decoded,
    };

    if (!req.auth.uid) {
      return res.status(401).json({ error: "Invalid token (missing sub)" });
    }

    next();
  } catch (e) {
    return res.status(401).json({ error: "Unauthorized", details: e.message });
  }
};
