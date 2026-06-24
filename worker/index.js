function corsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
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

function getExtension(key) {
  const match = key.match(/\.(jpg|jpeg|png|webp)$/i);
  return match ? match[0].toLowerCase() : ".jpg";
}

function getFolderFromKey(key) {
  return key.split("/").slice(0, -1).join("/");
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

async function putJson(env, key, data) {
  await env.ASTRO_PHOTO_BUCKET.put(key, JSON.stringify(data, null, 2), {
    httpMetadata: { contentType: "application/json" }
  });
}

async function getStatus(env) {
  return await readJsonObject(env, "_admin/status.json", {
    lastUploadAt: null,
    lastUploadKey: null,
    lastHideAt: null,
    lastHideKey: null,
    lastRestoreAt: null,
    lastRestoreKey: null,
    lastDeleteAt: null,
    lastDeleteKey: null,
    lastRedeployRequestedAt: null,
    lastRedeployStatus: null,
    lastInfoSaveAt: null,
    lastInfoFolder: null,
    lastMainImageAt: null,
    lastMainImageKey: null,
    lastObservationAt: null,
    lastObservationFolder: null
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

async function moveObject(env, fromKey, toKey) {
  const object = await env.ASTRO_PHOTO_BUCKET.get(fromKey);
  if (!object) return false;

  await env.ASTRO_PHOTO_BUCKET.put(toKey, object.body, {
    httpMetadata: object.httpMetadata
  });

  await env.ASTRO_PHOTO_BUCKET.delete(fromKey);
  return true;
}

async function getObservations(env, folder) {
  return await readJsonObject(env, `${folder}/observations.json`, []);
}

function summarizeObservations(observations) {
  const totalMinutes = observations.reduce(
    (sum, item) => sum + Number(item.minutes || 0),
    0
  );

  return {
    totalMinutes,
    totalHours: Math.round((totalMinutes / 60) * 10) / 10,
    sessions: observations.length
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return json({ ok: true });

    if (!checkAuth(request, env)) return unauthorized();

    const url = new URL(request.url);

    if (url.pathname === "/status" && request.method === "GET") {
      return json({ ok: true, status: await getStatus(env) });
    }

    if (url.pathname === "/list" && request.method === "GET") {
      const folder = cleanFolder(url.searchParams.get("folder"));
      if (!folder) return json({ ok: false, error: "Missing folder" }, 400);

      const listed = await env.ASTRO_PHOTO_BUCKET.list({ prefix: `${folder}/` });

      const files = listed.objects
        .filter((object) => isImageKey(object.key))
        .filter((object) => !object.key.includes("/Raw/"))
        .map((object) => ({
          key: object.key,
          filename: object.key.split("/").pop(),
          size: object.size,
          uploaded: object.uploaded,
          url: makePublicUrl(env, object.key),
          isMain: /\/main\.(jpg|jpeg|png|webp)$/i.test(object.key)
        }))
        .sort((a, b) => {
          if (a.isMain && !b.isMain) return -1;
          if (!a.isMain && b.isMain) return 1;
          return a.filename.localeCompare(b.filename);
        });

      return json({ ok: true, folder, files });
    }

    if (url.pathname === "/hidden" && request.method === "GET") {
      const listed = await env.ASTRO_PHOTO_BUCKET.list({ prefix: "_hidden/" });

      const files = listed.objects
        .filter((object) => isImageKey(object.key))
        .map((object) => ({
          hiddenKey: object.key,
          originalKey: object.key.replace(/^_hidden\//, ""),
          filename: object.key.split("/").pop(),
          size: object.size,
          uploaded: object.uploaded,
          url: makePublicUrl(env, object.key)
        }))
        .sort((a, b) => a.hiddenKey.localeCompare(b.hiddenKey));

      return json({ ok: true, files });
    }

    if (url.pathname === "/upload" && request.method === "PUT") {
      const key = url.searchParams.get("key");

      if (!key) return json({ ok: false, error: "Missing key" }, 400);
      if (!isImageKey(key)) {
        return json({ ok: false, error: "Only jpg, jpeg, png, and webp are allowed" }, 400);
      }

      await env.ASTRO_PHOTO_BUCKET.put(key, request.body, {
        httpMetadata: {
          contentType: request.headers.get("Content-Type") || "application/octet-stream"
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

    if (url.pathname === "/make-main" && request.method === "POST") {
      const { key: sourceKey } = await request.json();

      if (!sourceKey) return json({ ok: false, error: "Missing key" }, 400);
      if (!isImageKey(sourceKey)) {
        return json({ ok: false, error: "Selected file is not an image" }, 400);
      }

      const sourceObject = await env.ASTRO_PHOTO_BUCKET.get(sourceKey);
      if (!sourceObject) {
        return json({ ok: false, error: "Source file not found", key: sourceKey }, 404);
      }

      const folder = getFolderFromKey(sourceKey);
      const extension = getExtension(sourceKey);
      const mainKey = `${folder}/main${extension}`;

      await env.ASTRO_PHOTO_BUCKET.put(mainKey, sourceObject.body, {
        httpMetadata: sourceObject.httpMetadata
      });

      const status = await updateStatus(env, {
        lastMainImageAt: new Date().toISOString(),
        lastMainImageKey: mainKey
      });

      return json({
        ok: true,
        action: "main_image_updated",
        sourceKey,
        mainKey,
        url: makePublicUrl(env, mainKey),
        status
      });
    }

    if (url.pathname === "/hide" && request.method === "POST") {
      const { key } = await request.json();

      if (!key) return json({ ok: false, error: "Missing key" }, 400);

      const hiddenKey = `_hidden/${key}`;
      const moved = await moveObject(env, key, hiddenKey);

      if (!moved) return json({ ok: false, error: "File not found", key }, 404);

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

    if (url.pathname === "/restore" && request.method === "POST") {
      const { hiddenKey } = await request.json();

      if (!hiddenKey) return json({ ok: false, error: "Missing hiddenKey" }, 400);
      if (!hiddenKey.startsWith("_hidden/")) {
        return json({ ok: false, error: "Invalid hidden key" }, 400);
      }

      const originalKey = hiddenKey.replace(/^_hidden\//, "");
      const moved = await moveObject(env, hiddenKey, originalKey);

      if (!moved) {
        return json({ ok: false, error: "Hidden file not found", hiddenKey }, 404);
      }

      const status = await updateStatus(env, {
        lastRestoreAt: new Date().toISOString(),
        lastRestoreKey: originalKey
      });

      return json({
        ok: true,
        action: "restored",
        hiddenKey,
        originalKey,
        status
      });
    }

    if (url.pathname === "/delete-hidden" && request.method === "POST") {
      const { hiddenKey } = await request.json();

      if (!hiddenKey) return json({ ok: false, error: "Missing hiddenKey" }, 400);
      if (!hiddenKey.startsWith("_hidden/")) {
        return json({ ok: false, error: "Invalid hidden key" }, 400);
      }

      await env.ASTRO_PHOTO_BUCKET.delete(hiddenKey);

      const status = await updateStatus(env, {
        lastDeleteAt: new Date().toISOString(),
        lastDeleteKey: hiddenKey
      });

      return json({
        ok: true,
        action: "deleted_forever",
        hiddenKey,
        status
      });
    }

    if (url.pathname === "/info" && request.method === "GET") {
      const folder = cleanFolder(url.searchParams.get("folder"));
      if (!folder) return json({ ok: false, error: "Missing folder" }, 400);

      const info = await readJsonObject(env, `${folder}/info.json`, {
        name: folder.split("/").pop() || "",
        catalog: "",
        category: folder.startsWith("solar-system/") ? "Solar System" : "Deep Sky",
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
      if (!folder) return json({ ok: false, error: "Missing folder" }, 400);

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

    if (url.pathname === "/observations" && request.method === "GET") {
      const folder = cleanFolder(url.searchParams.get("folder"));
      if (!folder) return json({ ok: false, error: "Missing folder" }, 400);

      const observations = await getObservations(env, folder);

      return json({
        ok: true,
        folder,
        observations,
        summary: summarizeObservations(observations)
      });
    }

    if (url.pathname === "/observations" && request.method === "POST") {
      const folder = cleanFolder(url.searchParams.get("folder"));
      if (!folder) return json({ ok: false, error: "Missing folder" }, 400);

      const body = await request.json();
      const observations = await getObservations(env, folder);

      const observation = {
        id: crypto.randomUUID(),
        date: body.date || new Date().toISOString().slice(0, 10),
        minutes: Number(body.minutes || 0),
        subSeconds: Number(body.subSeconds || 0),
        notes: body.notes || "",
        createdAt: new Date().toISOString()
      };

      observations.push(observation);

      await putJson(env, `${folder}/observations.json`, observations);

      const status = await updateStatus(env, {
        lastObservationAt: new Date().toISOString(),
        lastObservationFolder: folder
      });

      return json({
        ok: true,
        action: "observation_added",
        folder,
        observation,
        observations,
        summary: summarizeObservations(observations),
        status
      });
    }

    if (url.pathname === "/delete-observation" && request.method === "POST") {
      const folder = cleanFolder(url.searchParams.get("folder"));
      if (!folder) return json({ ok: false, error: "Missing folder" }, 400);

      const body = await request.json();
      const observations = await getObservations(env, folder);
      const updated = observations.filter((item) => item.id !== body.id);

      await putJson(env, `${folder}/observations.json`, updated);

      return json({
        ok: true,
        action: "observation_deleted",
        folder,
        observations: updated,
        summary: summarizeObservations(updated)
      });
    }

    if (url.pathname === "/redeploy" && request.method === "POST") {
      if (!env.PAGES_DEPLOY_HOOK_URL) {
        return json({ ok: false, error: "Missing PAGES_DEPLOY_HOOK_URL" }, 500);
      }

      const response = await fetch(env.PAGES_DEPLOY_HOOK_URL, { method: "POST" });

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