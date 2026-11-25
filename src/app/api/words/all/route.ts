import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { getDb, isFirebaseAvailable } from "@/lib/firebase";
import { listWords } from "@/lib/in-memory-store";
import { WORDS_ALL_TAG } from "@/lib/cache-tags";

// 一覧ページ(/browse)用の「全語」API。
//
// 旧実装は /browse を開くたびに全語(=全ドキュメント)を Firestore から読んでいたため、
// 語数が増えると1回の閲覧で千件以上の読取になり、無料枠(5万読取/日)をすぐ使い切っていた。
// ここでは登録日(UTC)ごとに区切ってサーバー側のデータキャッシュに保存し、使い回す。
//   - 昨日までの日: 6時間ごとに読み直す（過去の日はほぼ変わらない）
//   - 今日:         5分ごとに読み直す（新しい投稿が早めに一覧へ出るように）
// 日ごとに分けているのは、キャッシュ1件あたりの容量上限(2MB)に収めるため。
// 通報で非表示になった時は reports API が WORDS_ALL_TAG を無効化して即時反映する。

// 最初の語の登録日(UTC)。これより前に登録された語は無い。
const FIRST_DAY = Date.UTC(2026, 5, 8); // 2026-06-08
const DAY_MS = 24 * 60 * 60 * 1000;
const PAST_REVALIDATE = 6 * 60 * 60;
const TODAY_REVALIDATE = 5 * 60;
const CONCURRENCY = 20;

type WordRow = Record<string, unknown> & { id: string; createdAt: string | null };

async function readDay(dayStart: number): Promise<WordRow[]> {
  const db = await getDb();
  const snapshot = await db
    .collection("words")
    .where("isVisible", "==", true)
    .where("createdAt", ">=", new Date(dayStart))
    .where("createdAt", "<", new Date(dayStart + DAY_MS))
    .orderBy("createdAt", "desc")
    .get();
  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      word: data.word || "",
      reading: data.reading || "",
      partOfSpeech: data.partOfSpeech || "",
      definition: data.definition || "",
      etymology: data.etymology || "",
      examples: data.examples || [],
      synonyms: data.synonyms || "",
      nickname: data.nickname || "",
      kojienFormatted: data.kojienFormatted || "",
      likes: data.likes || 0,
      viewCount: data.viewCount || 0,
      isVisible: true,
      source: data.source || "user",
      language: data.language || "ja",
      createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
    };
  });
}

function cachedDay(dayStart: number, isToday: boolean): Promise<WordRow[]> {
  return unstable_cache(() => readDay(dayStart), ["words-day", String(dayStart)], {
    revalidate: isToday ? TODAY_REVALIDATE : PAST_REVALIDATE,
    tags: [WORDS_ALL_TAG],
  })();
}

export async function GET() {
  if (!isFirebaseAvailable()) {
    // インメモリモード（Firebase未構成のローカル開発用）
    const words = listWords({ sort: "newest", limit: 100000 }).map(
      ({ authorToken: _at, ...rest }) => rest
    );
    return NextResponse.json({ words }, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    const days: number[] = [];
    for (let d = today; d >= FIRST_DAY; d -= DAY_MS) days.push(d); // 新しい日から

    const perDay: WordRow[][] = new Array(days.length);
    for (let i = 0; i < days.length; i += CONCURRENCY) {
      const chunk = days.slice(i, i + CONCURRENCY);
      const results = await Promise.all(chunk.map((d) => cachedDay(d, d === today)));
      results.forEach((r, j) => { perDay[i + j] = r; });
    }

    return NextResponse.json(
      { words: perDay.flat() },
      { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } }
    );
  } catch (error) {
    // 無料枠超過や一時障害。空配列をキャッシュさせないよう 503 をキャッシュ無しで返す。
    console.error("Firebase read error (words/all):", error);
    return NextResponse.json(
      { error: "busy", busy: true },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
