import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

function getEnv(name) {
  return import.meta.env?.[name] || process.env[name];
}

const accountId = getEnv("R2_ACCOUNT_ID");
const accessKeyId = getEnv("R2_ACCESS_KEY_ID");
const secretAccessKey = getEnv("R2_SECRET_ACCESS_KEY");
const bucketName = getEnv("R2_BUCKET_NAME");
const publicBaseUrl = getEnv("PUBLIC_R2_PUBLIC_BASE_URL");

const imageExtensions = [".jpg", ".jpeg", ".png", ".webp"];
const rawExtensions = [".fit", ".fits", ".tif", ".tiff", ".ser", ".zip", ".raw"];

function requireEnv(value, name) {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
}

requireEnv(accountId, "R2_ACCOUNT_ID");
requireEnv(accessKeyId, "R2_ACCESS_KEY_ID");
requireEnv(secretAccessKey, "R2_SECRET_ACCESS_KEY");
requireEnv(bucketName, "R2_BUCKET_NAME");
requireEnv(publicBaseUrl, "PUBLIC_R2_PUBLIC_BASE_URL");

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey }
});

function hasExtension(key, extensions) {
  const lower = key.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

function makeLabelFromFilename(key) {
  const filename = key.split("/").pop() || key;

  return filename
    .replace(/\.[^/.]+$/, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function makeFileType(key) {
  const ext = key.split(".").pop()?.toUpperCase() || "FILE";
  return ext;
}

function makePublicUrl(key) {
  return `${publicBaseUrl.replace(/\/$/, "")}/${key}`;
}

function sortImages(images) {
  return images.sort((a, b) => {
    const aName = a.key.toLowerCase();
    const bName = b.key.toLowerCase();

    const score = (name) => {
      if (name.includes("main")) return 1;
      if (name.includes("processed")) return 2;
      if (name.includes("final")) return 3;
      if (name.includes("detail")) return 4;
      if (name.includes("raw")) return 9;
      return 5;
    };

    return score(aName) - score(bName) || aName.localeCompare(bName);
  });
}

async function listObjects(prefix) {
  const response = await r2.send(
    new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix
    })
  );

  return response.Contents || [];
}

export async function getImagesForFolder(folder) {
  const objects = await listObjects(folder);

  const images = objects
    .filter((object) => object.Key && hasExtension(object.Key, imageExtensions))
    .filter((object) => !object.Key.includes("/Raw/"))
    .map((object) => ({
      key: object.Key,
      url: makePublicUrl(object.Key),
      label: makeLabelFromFilename(object.Key)
    }));

  return sortImages(images);
}

export async function getDownloadsForFolder(folder) {
  const rawFolder = `${folder.replace(/\/$/, "")}/Raw/`;
  const objects = await listObjects(rawFolder);

  return objects
    .filter((object) => object.Key && hasExtension(object.Key, rawExtensions))
    .map((object) => ({
      key: object.Key,
      url: makePublicUrl(object.Key),
      label: makeLabelFromFilename(object.Key),
      type: makeFileType(object.Key)
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}