import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";

const R2_ACCOUNT_ID = import.meta.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = import.meta.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = import.meta.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = import.meta.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL =
  import.meta.env.R2_PUBLIC_URL ||
  import.meta.env.PUBLIC_R2_PUBLIC_BASE_URL;

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

requireEnv("R2_ACCOUNT_ID", R2_ACCOUNT_ID);
requireEnv("R2_ACCESS_KEY_ID", R2_ACCESS_KEY_ID);
requireEnv("R2_SECRET_ACCESS_KEY", R2_SECRET_ACCESS_KEY);
requireEnv("R2_BUCKET_NAME", R2_BUCKET_NAME);
requireEnv("R2_PUBLIC_URL or PUBLIC_R2_PUBLIC_BASE_URL", R2_PUBLIC_URL);

const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

function cleanPublicUrl() {
  return R2_PUBLIC_URL.replace(/\/$/, "");
}

function isImageFile(key) {
  const lower = key.toLowerCase();

  return (
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".png") ||
    lower.endsWith(".webp")
  );
}

function isMainImage(key) {
  const lower = key.toLowerCase();

  return (
    lower.endsWith("/main.jpg") ||
    lower.endsWith("/main.jpeg") ||
    lower.endsWith("/main.png") ||
    lower.endsWith("/main.webp")
  );
}

function isSkyMapImage(key) {
  const lower = key.toLowerCase();

  return (
    lower.endsWith("/sky-map.jpg") ||
    lower.endsWith("/sky-map.jpeg") ||
    lower.endsWith("/sky-map.png") ||
    lower.endsWith("/sky-map.webp")
  );
}

function titleFromFolder(folderName) {
  return folderName
    .replace(/-/g, " ")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function slugFromFolder(folderName) {
  return folderName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function categoryFromFolder(folder) {
  const topFolder = folder.split("/")[0];

  if (topFolder === "deep-sky") return "Deep Sky";
  if (topFolder === "solar-system") return "Solar System";

  return titleFromFolder(topFolder);
}

function getFilenameFromKey(key) {
  return key.split("/").pop();
}

function isHiddenPhoto(key, folder, hiddenList) {
  if (!Array.isArray(hiddenList)) return false;

  const filename = getFilenameFromKey(key);
  const relativePath = key.replace(`${folder}/`, "");

  return (
    hiddenList.includes(filename) ||
    hiddenList.includes(relativePath) ||
    hiddenList.includes(key)
  );
}

async function streamToText(stream) {
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf-8");
}

async function getJsonIfExists(key) {
  try {
    const result = await r2Client.send(
      new GetObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
      })
    );

    const text = await streamToText(result.Body);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function listAllR2Objects() {
  let continuationToken = undefined;
  const allObjects = [];

  do {
    const result = await r2Client.send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET_NAME,
        ContinuationToken: continuationToken,
      })
    );

    allObjects.push(...(result.Contents || []));
    continuationToken = result.NextContinuationToken;
  } while (continuationToken);

  return allObjects.map((object) => object.Key).filter(Boolean);
}

export async function getTargetsFromR2() {
  const publicUrl = cleanPublicUrl();
  const objectKeys = await listAllR2Objects();

  const mainImageKeys = objectKeys.filter(isMainImage);

  const targets = await Promise.all(
    mainImageKeys.map(async (mainImageKey) => {
      const folder = mainImageKey.split("/").slice(0, -1).join("/");
      const folderName = folder.split("/").pop();

      const info = await getJsonIfExists(`${folder}/info.json`);
      const hiddenList = await getJsonIfExists(`${folder}/hidden.json`);

      const skyMapKey = objectKeys.find((key) => {
        return key.startsWith(`${folder}/`) && isSkyMapImage(key);
      });

      const photos = objectKeys
        .filter((key) => key.startsWith(`${folder}/`))
        .filter((key) => isImageFile(key))
        .filter((key) => !isSkyMapImage(key))
        .filter((key) => !isHiddenPhoto(key, folder, hiddenList))
        .map((key) => ({
          key,
          url: `${publicUrl}/${key}`,
          filename: getFilenameFromKey(key),
          isMain: key === mainImageKey,
        }));

      const visibleMainImage =
        photos.find((photo) => photo.isMain) || photos[0];

      return {
        slug: info?.slug || slugFromFolder(folderName),
        folder,

        name: info?.name || titleFromFolder(folderName),
        catalog: info?.catalog || "",
        alsoKnownAs: info?.alsoKnownAs || "",
        category: info?.category || categoryFromFolder(folder),
        objectType: info?.objectType || "",
        constellation: info?.constellation || "",
        distance: info?.distance || "",

        shortDescription:
          info?.shortDescription || "Astrophotography target.",
        description: info?.description || "",
        beginnerNote: info?.beginnerNote || "",

        equipment: info?.equipment || "",
        captureDate: info?.captureDate || "",
        totalExposure: info?.totalExposure || "",
        processing: info?.processing || "",
        bortle: info?.bortle || "",
        tags: Array.isArray(info?.tags) ? info.tags : [],

        imageUrl: visibleMainImage?.url || `${publicUrl}/${mainImageKey}`,
        skyMapUrl: skyMapKey ? `${publicUrl}/${skyMapKey}` : "",

        photoCount: photos.length,
        photos,
      };
    })
  );

  return targets.sort((a, b) => {
    if (a.category !== b.category) {
      return a.category.localeCompare(b.category);
    }

    return a.name.localeCompare(b.name);
  });
}

export async function getTargetBySlug(slug) {
  const targets = await getTargetsFromR2();

  return targets.find((target) => target.slug === slug) || null;
}

export async function getImagesForFolder(folder) {
  const publicUrl = cleanPublicUrl();
  const objectKeys = await listAllR2Objects();
  const hiddenList = await getJsonIfExists(`${folder}/hidden.json`);

  return objectKeys
    .filter((key) => key.startsWith(`${folder}/`))
    .filter((key) => isImageFile(key))
    .filter((key) => !isSkyMapImage(key))
    .filter((key) => !isHiddenPhoto(key, folder, hiddenList))
    .map((key) => ({
      key,
      url: `${publicUrl}/${key}`,
      filename: getFilenameFromKey(key),
      isMain:
        key.toLowerCase().endsWith("/main.jpg") ||
        key.toLowerCase().endsWith("/main.jpeg") ||
        key.toLowerCase().endsWith("/main.png") ||
        key.toLowerCase().endsWith("/main.webp"),
    }));
}