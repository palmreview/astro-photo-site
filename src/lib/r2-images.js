import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";

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

function isAnnotatedKey(key) {
  return /\/annotated\.(jpg|jpeg|png|webp)$/i.test(key);
}

function makeLabelFromFilename(key) {
  const filename = key.split("/").pop() || key;
  return filename
    .replace(/\.[^/.]+$/, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function makeFileType(key) {
  return key.split(".").pop()?.toUpperCase() || "FILE";
}

function makePublicUrl(key) {
  return `${publicBaseUrl.replace(/\/$/, "")}/${key}`;
}

function makeSlug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function makeNameFromFolder(folder) {
  return folder.split("/").filter(Boolean).pop() || folder;
}

function sortImages(images) {
  return images.sort((a, b) => {
    const score = (name) => {
      const lower = name.toLowerCase();
      if (lower.match(/\/main\.(jpg|jpeg|png|webp)$/)) return 1;
      if (lower.includes("processed")) return 2;
      if (lower.includes("final")) return 3;
      if (lower.includes("detail")) return 4;
      if (lower.includes("annotated")) return 8;
      if (lower.includes("raw")) return 9;
      return 5;
    };

    return score(a.key) - score(b.key) || a.key.localeCompare(b.key);
  });
}

async function listObjects(prefix = "") {
  let token;
  const allObjects = [];

  do {
    const response = await r2.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix,
        ContinuationToken: token
      })
    );

    allObjects.push(...(response.Contents || []));
    token = response.NextContinuationToken;
  } while (token);

  return allObjects;
}

async function getJson(key) {
  try {
    const response = await r2.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: key
      })
    );

    const text = await response.Body.transformToString();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function getImagesForFolder(folder) {
  const objects = await listObjects(folder);

  const images = objects
    .filter((object) => object.Key && hasExtension(object.Key, imageExtensions))
    .filter((object) => !object.Key.includes("/Raw/"))
    .filter((object) => !object.Key.startsWith("_hidden/"))
    .filter((object) => !isAnnotatedKey(object.Key))
    .map((object) => ({
      key: object.Key,
      url: makePublicUrl(object.Key),
      label: makeLabelFromFilename(object.Key)
    }));

  return sortImages(images);
}

export async function getAnnotatedImageForFolder(folder) {
  const objects = await listObjects(folder);

  const annotated = objects
    .filter((object) => object.Key && hasExtension(object.Key, imageExtensions))
    .filter((object) => !object.Key.startsWith("_hidden/"))
    .find((object) => isAnnotatedKey(object.Key));

  if (!annotated?.Key) return null;

  return {
    key: annotated.Key,
    url: makePublicUrl(annotated.Key),
    label: "Annotated View"
  };
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

export async function getObservationsForFolder(folder) {
  const data = await getJson(`${folder}/observations.json`);
  const observations = Array.isArray(data) ? data : [];

  const totalMinutes = observations.reduce(
    (sum, item) => sum + Number(item.minutes || 0),
    0
  );

  return {
    observations,
    summary: {
      totalMinutes,
      totalHours: Math.round((totalMinutes / 60) * 10) / 10,
      sessions: observations.length
    }
  };
}

export async function getDiscoveredTargets() {
  const objects = await listObjects("");
  const folders = new Set();

  for (const object of objects) {
    const key = object.Key;
    if (!key) continue;
    if (key.startsWith("_hidden/")) continue;
    if (key.includes("/Raw/")) continue;
    if (!hasExtension(key, imageExtensions)) continue;

    const parts = key.split("/");
    if (parts.length < 3) continue;

    folders.add(`${parts[0]}/${parts[1]}`);
  }

  const targets = await Promise.all(
    [...folders].map(async (folder) => {
      const info = await getJson(`${folder}/info.json`);
      const folderName = makeNameFromFolder(folder);
      const category = folder.startsWith("solar-system/")
        ? "Solar System"
        : "Deep Sky";

      return {
        slug: info?.slug || makeSlug(folderName),
        name: info?.name || folderName,
        catalog: info?.catalog || "",
        category: info?.category || category,
        folder,
        shortDescription:
          info?.shortDescription ||
          info?.description ||
          "A space photo from Andrew's astrophotography collection.",
        description:
          info?.description ||
          "This target was automatically discovered from the image folder in Cloudflare R2.",
        distance: info?.distance,
        dateCaptured: info?.dateCaptured,
        equipment: info?.equipment,
        location: info?.location,
        whatYouAreSeeing:
          info?.whatYouAreSeeing ||
          "This image shows a real object in space captured through a smart telescope.",
        whyItIsInteresting:
          info?.whyItIsInteresting ||
          "It is part of a growing beginner-friendly astrophotography gallery.",
        captureNotes:
          info?.captureNotes ||
          "Uploaded through the site admin tools."
      };
    })
  );

  return targets.sort((a, b) => a.name.localeCompare(b.name));
}