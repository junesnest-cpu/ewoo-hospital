export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "서버에 ANTHROPIC_API_KEY가 설정되지 않았습니다." });

  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "분석할 텍스트가 없습니다." });

    const prompt = `당신은 병원 병동 관리 시스템의 AI 분석기입니다.
아래 메신저 대화를 분석하여 환자별 정보를 JSON 배열로만 출력하세요 (다른 텍스트 없이).

병실: 2병동(201~206), 3병동(301~306), 5병동(501~506), 6병동(601~603)

[
  {
    "room": "호수",
    "name": "환자명",
    "discharge": "M/D 형식 퇴원일 또는 미정",
    "note": "치료/약품/스케줄 요약",
    "scheduleAlert": true또는false
  }
]

메신저:
${text}`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    const raw = data.content?.map((c) => c.text || "").join("") || "";
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const result = JSON.parse(cleaned);
    return res.status(200).json({ result });
  } catch (err) {
    return res.status(500).json({ error: "분석 오류: " + err.message });
  }
}
