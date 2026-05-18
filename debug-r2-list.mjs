import "dotenv/config";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

const command = new ListObjectsV2Command({
  Bucket: process.env.R2_BUCKET_NAME
});

const response = await r2.send(command);

console.log("Bucket:", process.env.R2_BUCKET_NAME);
console.log("Objects found:");

for (const object of response.Contents || []) {
  console.log(object.Key);
}