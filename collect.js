// 매일 자동 실행되는 유튜브 데이터 수집 스크립트.
// data/channels.json에 등록된 채널마다 최신 영상 몇 개의 통계를 가져와
// data/history.csv 맨 끝에 새 행으로 쌓는다(누적, append-only).
//
// 실행 방식: .github/workflows/daily-collect.yml 이 매일 자동으로 이 파일을 node로 실행한다.
// 필요한 환경변수: YOUTUBE_API_KEY (저장소 Secrets에 등록된 값)

const fs = require("fs");
const path = require("path");

const API_KEY = process.env.YOUTUBE_API_KEY;
const VIDEOS_PER_CHANNEL = 10;
const CHANNELS_PATH = path.join(__dirname, "..", "..", "data", "channels.json");
const HISTORY_PATH = path.join(__dirname, "..", "..", "data", "history.csv");
const CSV_HEADERS = [
  "VIDEO_ID", "업로드일", "Channel", "Content", "링크", "조회일자", "조회시간", "Type", "Views", "Likes", "Comments"
];

// 한국 시간(Asia/Seoul) 기준 오늘 날짜를 "YYYY-MM-DD"로 만든다.
// GitHub Actions 서버는 UTC로 돌아서, 그냥 new Date()를 쓰면 날짜가 하루 어긋날 수 있다.
function todayInSeoul() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
}

// ISO8601 영상 길이(예: "PT1M5S")를 초 단위 숫자로 바꾼다.
function parseDurationSeconds(iso) {
  var m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  var h = parseInt(m[1] || "0", 10);
  var min = parseInt(m[2] || "0", 10);
  var s = parseInt(m[3] || "0", 10);
  return h * 3600 + min * 60 + s;
}

// 웹앱 화면과 같은 기준(60초 이하 = Shorts)으로 구분한다.
function classifyType(durationSeconds) {
  if (durationSeconds == null) return "-";
  return durationSeconds <= 60 ? "Shorts" : "Longform";
}

// CSV 한 칸 값에 쉼표/따옴표/줄바꿈이 있으면 규격대로 큰따옴표로 감싼다.
function csvCell(value) {
  var str = String(value == null ? "" : value);
  if (/[",\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function csvRow(cells) {
  return cells.map(csvCell).join(",") + "\n";
}

async function fetchJson(url) {
  var res = await fetch(url);
  if (!res.ok) {
    throw new Error("HTTP " + res.status + " " + url);
  }
  return res.json();
}

// @핸들로 채널 기본정보(채널명, 업로드 재생목록 ID)를 가져온다.
async function fetchChannelByHandle(handle) {
  var url = "https://www.googleapis.com/youtube/v3/channels"
    + "?part=snippet,contentDetails&forHandle=" + encodeURIComponent(handle)
    + "&key=" + API_KEY;
  var json = await fetchJson(url);
  var item = json.items && json.items[0];
  if (!item) throw new Error("채널을 찾을 수 없음: @" + handle);
  return {
    channelTitle: item.snippet.title,
    uploadsPlaylistId: item.contentDetails.relatedPlaylists.uploads
  };
}

// 업로드 재생목록에서 최신 영상 ID 목록을 가져온다.
async function fetchLatestVideoIds(uploadsPlaylistId, count) {
  var url = "https://www.googleapis.com/youtube/v3/playlistItems"
    + "?part=contentDetails&maxResults=" + count
    + "&playlistId=" + uploadsPlaylistId
    + "&key=" + API_KEY;
  var json = await fetchJson(url);
  return (json.items || []).map(function (item) {
    return item.contentDetails.videoId;
  });
}

// 영상 ID 목록으로 제목/업로드일/길이/통계를 한 번에 가져온다.
async function fetchVideoDetails(videoIds) {
  if (videoIds.length === 0) return [];
  var url = "https://www.googleapis.com/youtube/v3/videos"
    + "?part=snippet,contentDetails,statistics"
    + "&id=" + videoIds.join(",")
    + "&key=" + API_KEY;
  var json = await fetchJson(url);
  return json.items || [];
}

async function collectChannel(channelConfig) {
  var channel = await fetchChannelByHandle(channelConfig.handle);
  var videoIds = await fetchLatestVideoIds(channel.uploadsPlaylistId, VIDEOS_PER_CHANNEL);
  var videos = await fetchVideoDetails(videoIds);
  return videos.map(function (v) {
    var durationSeconds = parseDurationSeconds(v.contentDetails.duration);
    var stats = v.statistics || {};
    return {
      channelTitle: channel.channelTitle,
      title: v.snippet.title,
      publishedAt: v.snippet.publishedAt.slice(0, 10),
      type: classifyType(durationSeconds),
      videoId: v.id,
      views: stats.viewCount != null ? stats.viewCount : "-",
      likes: stats.likeCount != null ? stats.likeCount : "-",
      comments: stats.commentCount != null ? stats.commentCount : "-"
    };
  });
}

async function main() {
  if (!API_KEY) {
    throw new Error("YOUTUBE_API_KEY 환경변수가 없습니다. 저장소 Secrets 등록을 확인하세요.");
  }

  var baseDate = todayInSeoul();

  // 이미 오늘 날짜로 수집된 데이터가 있으면 중복 수집을 막는다(수동 재실행 대비).
  if (fs.existsSync(HISTORY_PATH)) {
    var existing = fs.readFileSync(HISTORY_PATH, "utf8");
    if (existing.indexOf("," + baseDate + ",9:00,") !== -1) {
      console.log("오늘(" + baseDate + ") 데이터가 이미 있어 건너뜁니다.");
      return;
    }
  }

  var channels = JSON.parse(fs.readFileSync(CHANNELS_PATH, "utf8"));
  var rows = [];

  // 채널 하나가 실패해도(예: 핸들 오류) 나머지 채널은 계속 수집한다.
  for (var i = 0; i < channels.length; i++) {
    try {
      var channelRows = await collectChannel(channels[i]);
      rows = rows.concat(channelRows);
      console.log("완료: @" + channels[i].handle + " (" + channelRows.length + "개 영상)");
    } catch (err) {
      console.error("실패: @" + channels[i].handle + " → " + err.message);
    }
  }

  var fileExists = fs.existsSync(HISTORY_PATH);
  var csvText = "";
  if (!fileExists) {
    csvText += csvRow(CSV_HEADERS);
  }
  rows.forEach(function (row) {
    csvText += csvRow([
      row.videoId, row.publishedAt, row.channelTitle, row.title,
      "https://youtu.be/" + row.videoId, baseDate, "9:00",
      row.type, row.views, row.likes, row.comments
    ]);
  });

  fs.appendFileSync(HISTORY_PATH, csvText, "utf8");
  console.log("총 " + rows.length + "개 행을 " + HISTORY_PATH + " 에 추가했습니다.");
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
