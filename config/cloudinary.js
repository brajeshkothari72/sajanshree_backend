const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

// Configure Cloudinary
console.log('🔧 Configuring Cloudinary...');
console.log('📍 Cloud Name:', process.env.CLOUDINARY_CLOUD_NAME ? '✓ Set' : '✗ Missing');
console.log('🔑 API Key:', process.env.CLOUDINARY_API_KEY ? '✓ Set' : '✗ Missing');
console.log('🔐 API Secret:', process.env.CLOUDINARY_API_SECRET ? '✓ Set' : '✗ Missing');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Verify Cloudinary connection — but only when there is something to verify.
// ping() THROWS synchronously on a missing cloud_name rather than rejecting, so
// requiring this module without credentials took the whole process down. That
// made the module unusable from tests and would kill the server on a deploy
// where the Cloudinary vars had not been set yet.
if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY) {
  try {
    cloudinary.api.ping()
      .then(() => console.log('✅ Cloudinary connected successfully!'))
      .catch((err) => console.error('❌ Cloudinary connection failed:', err.message));
  } catch (err) {
    console.error('❌ Cloudinary configuration invalid:', err.message || err);
  }
} else {
  console.log('💤 Cloudinary not configured — invoice PDFs will not be attached.');
}

// Storage for order images
const orderImageStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (_req, file) => {
    console.log('📸 Processing order image upload...');
    console.log('📁 File details:', {
      fieldname: file.fieldname,
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: `${(file.size / 1024).toFixed(2)} KB`
    });

    return {
      folder: 'sajan-shree/orders',
      allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
      transformation: [{ width: 1200, height: 1200, crop: 'limit' }],
    };
  },
});

console.log('📦 Order image storage configured');

// Storage for product detail images
const productDetailStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'sajan-shree/product-details',
    allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
    transformation: [{ width: 500, height: 500, crop: 'limit' }],
  },
});

const uploadOrderImage = multer({ storage: orderImageStorage });
const uploadProductDetailImage = multer({ storage: productDetailStorage });

/**
 * Upload an invoice PDF and return its public URL.
 *
 * WhatsApp fetches the document itself, so the URL has to be reachable without
 * credentials. resource_type 'raw' keeps the PDF a PDF — 'image' would let
 * Cloudinary rasterise it, and the customer would receive a picture of page one
 * instead of a document they can save.
 *
 * public_id is the voucher GUID, which is unique per bill and stable, so a
 * resend overwrites rather than accumulating copies of the same invoice.
 */
async function uploadInvoicePdf(buffer, publicId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'sajan-shree/invoices',
        public_id: String(publicId).replace(/[^A-Za-z0-9._-]/g, '_'),
        resource_type: 'raw',
        format: 'pdf',
        overwrite: true,
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

module.exports = {
  cloudinary,
  uploadOrderImage,
  uploadProductDetailImage,
  uploadInvoicePdf,
};
