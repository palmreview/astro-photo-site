function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization"
    }
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

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return json({ ok: true });
    }

    if (!checkAuth(request, env)) {
      return unauthorized();
    }

    const url = new URL(request.url);

    if (url.pathname === "/upload" && request.method === "PUT") {
      const key = url.searchParams.get("key");

      if (!key) {
        return json({ ok: false, error: "Missing key" }, 400);
      }

      if (!isImageKey(key)) {
        return json({ ok: false, error: "Only jpg, jpeg, png, and webp are allowed" }, 400);
      }

      await env.ASTRO_PHOTO_BUCKET.put(key, request.body, {
        httpMetadata: {
          contentType: request.headers.get("Content-Type") || "application/octet-stream"
        }
      });

      return json({ ok: true, action: "uploaded", key });
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

      return json({
        ok: true,
        action: "hidden",
        originalKey: key,
        hiddenKey
      });
    }

    return json({ ok: false, error: "Not found" }, 404);
  }
};