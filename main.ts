Deno.serve(async (req) => {
  console.log("=== Incoming Request ===");
  console.log("Method:", req.method);

  if (req.method !== "POST") {
    return new Response("OK", { status: 200 });
  }

  try {
    const rawBody = await req.text();
    console.log("=== Raw Payload ===");
    console.log(rawBody);

    const payload = JSON.parse(rawBody);
    console.log("=== Parsed eventType ===", payload.eventType);

    if (!payload.eventType) {
      console.log("No eventType — ping");
      return new Response("ping ok", { status: 200 });
    }

    if (!["git.pullrequest.created", "git.pullrequest.updated"].includes(payload.eventType)) {
      console.log("Event not handled:", payload.eventType);
      return new Response("ignored", { status: 200 });
    }

    const pr = payload.resource;
    console.log("=== PR Info ===");
    console.log("PR ID:", pr.pullRequestId);
    console.log("PR Title:", pr.title);
    console.log("Remote URL:", pr.repository?.remoteUrl);
    console.log("Project name:", pr.repository?.project?.name);
    console.log("Repo ID:", pr.repository?.id);

    const { id: repoId, project: { name: projectName }, remoteUrl } = pr.repository;
    const prId = pr.pullRequestId;
    const encodedProject = encodeURIComponent(projectName); // ← fix for spaces

    const tfsBase = remoteUrl.match(/^(https?:\/\/.+?\/tfs\/[^/]+)/i)?.[1];
    console.log("=== TFS Base URL ===", tfsBase);

    if (!tfsBase) {
      console.log("Could not parse TFS base URL — test payload");
      return new Response("test ok", { status: 200 });
    }

    const sourceCommit = pr.lastMergeSourceCommit?.commitId;
    const targetCommit = pr.lastMergeTargetCommit?.commitId;
    console.log("Source commit:", sourceCommit);
    console.log("Target commit:", targetCommit);

    if (!sourceCommit || !targetCommit) {
      console.log("Missing commits — skipping");
      return new Response("no commits yet", { status: 200 });
    }

    const TFS_PAT = Deno.env.get("TFS_PAT");
    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    console.log("TFS_PAT set:", !!TFS_PAT);
    console.log("ANTHROPIC_API_KEY set:", !!ANTHROPIC_API_KEY);

    if (!TFS_PAT || !ANTHROPIC_API_KEY) {
      console.log("ERROR: Missing env vars!");
      return new Response("Missing env vars", { status: 500 });
    }

    const tfsAuth = "Basic " + btoa(`:${TFS_PAT}`);

    // Test TFS connectivity first
    console.log("=== Testing TFS Connectivity ===");
    try {
      const pingResp = await fetch(
        `${tfsBase}/_apis/git/repositories?api-version=3.0`,
        { headers: { Authorization: tfsAuth }, signal: AbortSignal.timeout(10000) }
      );
      console.log("TFS ping status:", pingResp.status);
      if (!pingResp.ok) {
        const t = await pingResp.text();
        console.log("TFS ping error body:", t.slice(0, 300));
      }
    } catch (e) {
      console.log("TFS ping FAILED:", (e as Error).message);
    }

    // 1. Get changed files
    const diffUrl = `${tfsBase}/${encodedProject}/_apis/git/repositories/${repoId}/diffs/commits` +
      `?baseVersion=${targetCommit}&baseVersionType=commit` +
      `&targetVersion=${sourceCommit}&targetVersionType=commit&api-version=3.0`;

    console.log("=== Fetching Diff ===");
    console.log("Diff URL:", diffUrl);

    const diffResp = await fetch(diffUrl, {
      headers: { Authorization: tfsAuth },
      signal: AbortSignal.timeout(15000)
    });
    console.log("Diff response status:", diffResp.status);

    if (!diffResp.ok) {
      const errText = await diffResp.text();
      console.log("Diff fetch error:", errText);
      return new Response("Failed to fetch diff: " + errText, { status: 500 });
    }

    const diffData = await diffResp.json();
    console.log("Total changes:", diffData.changes?.length ?? 0);

    const files = (diffData.changes ?? []).filter((c: any) => !c.item.isFolder).slice(0, 10);
    console.log("Files to review:", files.map((f: any) => f.item.path));

    if (!files.length) {
      console.log("No files to review");
      return new Response("no files", { status: 200 });
    }

    // 2. Fetch file contents
    const fileParts: string[] = [];
    for (const change of files) {
      const path = change.item.path;
      console.log("Fetching file:", path, "changeType:", change.changeType);

      if (change.changeType === "delete") {
        fileParts.push(`### DELETED: ${path}`);
        continue;
      }

      const fileUrl = `${tfsBase}/${encodedProject}/_apis/git/repositories/${repoId}/items` +
        `?path=${encodeURIComponent(path)}&version=${sourceCommit}&versionType=commit&api-version=3.0`;

      const fileResp = await fetch(fileUrl, {
        headers: { Authorization: tfsAuth, Accept: "text/plain" },
        signal: AbortSignal.timeout(15000)
      });
      console.log("File fetch status:", fileResp.status, "for", path);

      if (!fileResp.ok) {
        const errText = await fileResp.text();
        console.log("File fetch error:", errText);
        fileParts.push(`### ${path} — failed to fetch (${fileResp.status})`);
        continue;
      }

      const content = (await fileResp.text()).slice(0, 3000);
      console.log("Fetched", content.length, "chars from", path);
      fileParts.push(`### ${path}\n\`\`\`\n${content}\n\`\`\``);
    }

    // 3. Call Claude
    console.log("=== Calling Claude API ===");
    const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: `You are a code reviewer. Review this pull request and give concise feedback.

PR Title: ${pr.title}
PR Description: ${pr.description || "(none)"}
Source: ${pr.sourceRefName} → ${pr.targetRefName}

Changed files:
${fileParts.join("\n\n")}

Provide:
1. Summary (1-2 sentences)
2. Issues found (bugs, security, logic)
3. Suggestions (non-blocking improvements)
4. Verdict: ✅ Looks good | ⚠️ Minor issues | ❌ Needs work`
        }]
      }),
      signal: AbortSignal.timeout(30000)
    });

    console.log("Claude response status:", claudeResp.status);

    if (!claudeResp.ok) {
      const errText = await claudeResp.text();
      console.log("Claude API error:", errText);
      return new Response("Claude error: " + errText, { status: 500 });
    }

    const claudeData = await claudeResp.json();
    const review = claudeData.content?.find((b: any) => b.type === "text")?.text ?? "No review generated.";
    console.log("Review length:", review.length, "chars");

    // 4. Post comment to TFS PR
    const commentUrl = `${tfsBase}/${encodedProject}/_apis/git/repositories/${repoId}` +
      `/pullRequests/${prId}/threads?api-version=3.0`;

    console.log("=== Posting Comment ===");
    console.log("Comment URL:", commentUrl);

    const commentResp = await fetch(commentUrl, {
      method: "POST",
      headers: { Authorization: tfsAuth, "Content-Type": "application/json" },
      body: JSON.stringify({
        comments: [{ parentCommentId: 0, content: `## 🤖 Claude Code Review\n\n${review}`, commentType: 1 }],
        status: 1
      }),
      signal: AbortSignal.timeout(15000)
    });

    console.log("Comment post status:", commentResp.status);

    if (!commentResp.ok) {
      const errText = await commentResp.text();
      console.log("Comment post error:", errText);
      return new Response("Failed to post comment: " + errText, { status: 500 });
    }

    console.log("=== Done! Review posted to PR #" + prId + " ===");
    return new Response("Review posted", { status: 200 });

  } catch (err) {
    console.error("=== UNHANDLED ERROR ===");
    console.error("Message:", (err as Error).message);
    console.error("Stack:", (err as Error).stack);
    return new Response("Error: " + (err as Error).message, { status: 500 });
  }
});