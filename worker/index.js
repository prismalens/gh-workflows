function serializeJson(val, fallback) {
  if (val === undefined || val === null) {
    return fallback;
  }
  return typeof val === "string" ? val : JSON.stringify(val);
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response(null, { status: 405 });
    }

    // Reject missing or empty secret to prevent open access (#41).
    const token = env?.REVIEW_TELEMETRY_TOKEN;
    if (!token || request.headers.get("authorization") !== `Bearer ${token}`) {
      return new Response(null, { status: 401 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response(null, { status: 400 });
    }

    if (
      !payload ||
      typeof payload !== "object" ||
      typeof payload.session_id !== "string" ||
      typeof payload.repository !== "string"
    ) {
      return new Response(null, { status: 400 });
    }

    // Name columns literally so unmapped payload fields are dropped (#41).
    // Protect against retried POST requests without re-running (#41).
    try {
      await env.DB.prepare(
        `INSERT INTO usage_records (
          session_id,
          recorded_at,
          repository,
          pr_number,
          pr_url,
          head_sha,
          run_id,
          run_attempt,
          run_url,
          round_type,
          model,
          input_tokens,
          output_tokens,
          cache_read_input_tokens,
          cache_creation_input_tokens,
          total_cost_usd,
          duration_ms,
          duration_api_ms,
          num_turns,
          permission_denials,
          changed_files,
          diff_lines,
          per_model_usage,
          subagent_stats,
          raw_result
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)
        ON CONFLICT(session_id) DO NOTHING`
      ).bind(
        payload.session_id,
        payload.recorded_at ?? null,
        payload.repository,
        payload.pr_number ?? null,
        payload.pr_url ?? null,
        payload.head_sha ?? null,
        payload.run_id ?? null,
        payload.run_attempt ?? null,
        payload.run_url ?? null,
        payload.round_type ?? null,
        payload.model ?? null,
        payload.input_tokens ?? null,
        payload.output_tokens ?? null,
        payload.cache_read_input_tokens ?? null,
        payload.cache_creation_input_tokens ?? null,
        payload.total_cost_usd ?? null,
        payload.duration_ms ?? null,
        payload.duration_api_ms ?? null,
        payload.num_turns ?? null,
        payload.permission_denials ?? null,
        payload.changed_files ?? null,
        payload.diff_lines ?? null,
        serializeJson(payload.per_model_usage, "{}"),
        serializeJson(payload.subagent_stats, null),
        serializeJson(payload.raw_result, null)
      ).run();
    } catch {
      return new Response(null, { status: 500 });
    }

    return new Response(null, { status: 204 });
  },
};
