function corsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization"
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: corsHeaders()
  });
}

function unauthorized() {
  return json({ ok: false, error: "Unauthorized" }, 401);
}

function checkAuth(request, env) {
  const header = request.headers.get("Authorization") || "";
  return header === `Bearer ${env.ADMIN_TOKEN}`;
}

function isImageKey(key) {
  return /\.(jpg|jpeg|png|webp)$/i.test(key);
}

function makePublicUrl(env, key) {
  return `${env.PUBLIC_R2_PUBLIC_BASE_URL.replace(/\/$/, "")}/${key}`;
}

function cleanFolder(folder) {
  return folder?.trim().replace(/\/$/, "");
}

async function readJsonObject(env, key, fallback = null) {
  const object = await env.ASTRO_PHOTO_BUCKET.get(key);
  if (!object) return fallback;

  try {
    return JSON.parse(await object.text());
  } catch {
    return fallback;
  }
}

async function writeJsonObject(env, key, data) {
  await env.ASTRO_PHOTO_BUCKET.put(JSON.stringify(data, null, 2), {
    key
  });
}

async function putJson(env, key, data) {
  await env.ASTRO_PHOTO_BUCKET.put(key, JSON.stringify(data, null, 2), {
    httpMetadata: {
      contentType: "application/json"
    }
  });
}

async function getStatus(env) {
  return await readJsonObject(env, "_admin/status.json", {
    lastUploadAt: null,
    lastUploadKey: null,
    lastHideAt: null,
    lastHideKey: null,
    lastRedeployRequestedAt: null,
    lastRedeployStatus: null,
    lastInfoSaveAt: null,
    lastInfoFolder: null
  });
}

async function updateStatus(env, patch) {
  const status = await getStatus(env);
  const updated = {
    ...status,
    ...patch,
    updatedAt: new Date().toISOString()
  };

  await putJson(env, "_admin/status.json", updated);
  return updated;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return json({ ok: true });
    }

    if (!checkAuth(request, env)) {
      return unauthorized();
    }

    const url = new URL(request.url);

    if (url.pathname === "/status" && request.method === "GET") {
      const status = await getStatus(env);
      return json({ ok: true, status });
    }

    if (url.pathname === "/list" && request.method === "GET") {
      const folder = cleanFolder(url.searchParams.get("folder"));

      if (!folder) {
        return json({ ok: false, error: "Missing folder" }, 400);
      }

      const listed = await env.ASTRO_PHOTO_BUCKET.list({
        prefix: `${folder}/`
      });

      const files = listed.objects
        .filter((object) => isImageKey(object.key))
        .filter((object) => !object.key.includes("/Raw/"))
        .map((object) => ({
          key: object.key,
          filename: object.key.split("/").pop(),
          size: object.size,
          uploaded: object.uploaded,
          url: makePublicUrl(env, object.key)
        }))
        .sort((a, b) => a.filename.localeCompare(b.filename));

      return json({ ok: true, folder, files });
    }

    if (url.pathname === "/upload" && request.method === "PUT") {
      const key = url.searchParams.get("key");

      if (!key) {
        return json({ ok: false, error: "Missing key" }, 400);
      }

      if (!isImageKey(key)) {
        return json(
          { ok: false, error: "Only jpg, jpeg, png, and webp are allowed" },
          400
        );
      }

      await env.ASTRO_PHOTO_BUCKET.put(key, request.body, {
        httpMetadata: {
          contentType:
            request.headers.get("Content-Type") || "application/octet-stream"
        }
      });

      const status = await updateStatus(env, {
        lastUploadAt: new Date().toISOString(),
        lastUploadKey: key
      });

      return json({
        ok: true,
        action: "uploaded",
        key,
        url: makePublicUrl(env, key),
        status
      });
    }

    if (url.pathname === "/hide" && request.method === "POST") {
      const body = await request.json();
      const key = body.key;

      if (!key) {
        return json({ ok: false, error: "Missing key" }, 400);
      }

      const hiddenKey = `_hidden/${key}`;
      const object = await env.ASTRO_PHOTO_BUCKET.get(key);

      if (!object) {
        return json({ ok: false, error: "File not found", key }, 404);
      }

      await env.ASTRO_PHOTO_BUCKET.put(hiddenKey, object.body, {
        httpMetadata: object.httpMetadata
      });

      await env.ASTRO_PHOTO_BUCKET.delete(key);

      const status = await updateStatus(env, {
        lastHideAt: new Date().toISOString(),
        lastHideKey: key
      });

      return json({
        ok: true,
        action: "hidden",
        originalKey: key,
        hiddenKey,
        status
      });
    }

    if (url.pathname === "/info" && request.method === "GET") {
      const folder = cleanFolder(url.searchParams.get("folder"));

      if (!folder) {
        return json({ ok: false, error: "Missing folder" }, 400);
      }

      const info = await readJsonObject(env, `${folder}/info.json`, {
        name: folder.split("/").pop() || "",
        catalog: "",
        category: folder.startsWith("solar-system/")
          ? "Solar System"
          : "Deep Sky",
        shortDescription: "",
        description: "",
        distance: "",
        dateCaptured: "",
        equipment: "Seestar S30",
        location: "Florida, USA",
        whatYouAreSeeing: "",
        whyItIsInteresting: "",
        captureNotes: ""
      });

      return json({ ok: true, folder, info });
    }

    if (url.pathname === "/info" && request.method === "PUT") {
      const folder = cleanFolder(url.searchParams.get("folder"));

      if (!folder) {
        return json({ ok: false, error: "Missing folder" }, 400);
      }

      const info = await request.json();

      await putJson(env, `${folder}/info.json`, info);

      const status = await updateStatus(env, {
        lastInfoSaveAt: new Date().toISOString(),
        lastInfoFolder: folder
      });

      return json({
        ok: true,
        action: "info_saved",
        folder,
        key: `${folder}/info.json`,
        info,
        status
      });
    }

    if (url.pathname === "/redeploy" && request.method === "POST") {
      if (!env.PAGES_DEPLOY_HOOK_URL) {
        return json(
          { ok: false, error: "Missing PAGES_DEPLOY_HOOK_URL" },
          500
        );
      }

      const response = await fetch(env.PAGES_DEPLOY_HOOK_URL, {
        method: "POST"
      });

      const status = await updateStatus(env, {
        lastRedeployRequestedAt: new Date().toISOString(),
        lastRedeployStatus: response.status
      });

      return json({
        ok: response.ok,
        action: "redeploy_requested",
        status: response.status,
        adminStatus: status
      });
    }

    return json({ ok: false, error: "Not found" }, 404);
  }
};