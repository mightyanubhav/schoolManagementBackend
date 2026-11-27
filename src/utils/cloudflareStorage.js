import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

let client;

function getConfig() {
  const accountId = process.env.CLOUDFLARE_R2_ACCOUNT_ID;
  const accessKeyId = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
  const bucketName = process.env.CLOUDFLARE_R2_BUCKET_NAME;

  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) {
    const error = new Error("Cloudflare R2 is not configured. Set the R2 credentials and bucket in server/.env.");
    error.status = 503;
    throw error;
  }

  return { accountId, accessKeyId, secretAccessKey, bucketName };
}

function getClient() {
  const { accountId, accessKeyId, secretAccessKey } = getConfig();
  if (!client) {
    client = new S3Client({
      region: "auto",
      endpoint: process.env.CLOUDFLARE_R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });
  }
  return client;
}

export async function uploadPrivateObject({ key, file }) {
  const { bucketName } = getConfig();
  await getClient().send(new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
    ContentLength: file.size,
  }));
  return key;
}

export async function createPrivateDownloadUrl(key, { inline = false } = {}) {
  const { bucketName } = getConfig();
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: key,
    ...(inline ? { ResponseContentDisposition: "inline" } : { ResponseContentDisposition: "attachment" }),
  });
  return getSignedUrl(getClient(), command, { expiresIn: 600 });
}

export async function downloadPrivateObject(key) {
  const { bucketName } = getConfig();
  const response = await getClient().send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
  return {
    buffer: Buffer.from(await response.Body.transformToByteArray()),
    contentType: response.ContentType || "application/octet-stream",
  };
}

export async function deletePrivateObject(key) {
  const { bucketName } = getConfig();
  await getClient().send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
}
