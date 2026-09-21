// 매일 자동 실행되는 유튜브 데이터 수집 스크립트.
// data/channels.json에 등록된 채널마다, data/collect-config.json에 적힌 날짜(collectSince) 이후에
// 올라온 영상 "전부"의 통계를 가져와 data/history.csv 맨 끝에 새 행으로 쌓는다(누적, append-only).
// 개수 상한은 없고, 대신 업로드일 기준 시작 날짜로만 범위를 제한한다.
//
// collectSince 날짜를 바꾸고 싶으면 코드를 건드릴 필요 없이
// data/collect-config.json 파일의 "collectSince" 값만 고쳐서 GitHub에 다시 올리면 된다.
//
// 실행 방식: .github/workflows/daily-collect.yml 이 매일 자동으로 이 파일을 node로 실행한다.
// 필요한 환경변수: YOUTUBE_API_KEY (저장소 Secrets에 등록된 값)

const fs = require("fs");
const path = require("path");

const API_KEY = process.env.YOUTUBE_API_KEY;
const CHANNELS_PATH = path.join(__dirname, "..", "..", "data", "channels.json");
const CONFIG_PATH = path.join(__dirname, "..", "..", "data", "collect-config.json");
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

// data/collect-config.json에서 수집 시작 날짜(collectSince, "YYYY-MM-DD")를 읽는다.
function loadCollectSince() {
  var config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  if (!config.collectSince || !/^\d{4}-\d{2}-\d{2}$/.test(config.collectSince)) {
    throw new Error("data/collect-config.json의 collectSince 값이 없거나 'YYYY-MM-DD' 형식이 아닙니다.");
  }
  return config.collectSince;
}

// 업로드 재생목록은 최신 영상이 맨 앞에 오도록 정렬돼 있다.
// sinceDate(업로드일) 이후 영상을 앞에서부터 전부 모으다가, sinceDate보다 오래된 영상을 만나면
// 그 뒤는 더 볼 필요가 없으므로 페이지 요청을 멈춘다(개수 상한 없음, 시작 날짜로만 범위 제한).
async function fetchVideoIdsSince(uploadsPlaylistId, sinceDate) {
  var ids = [];
  var pageToken = "";

  while (true) {
    var url = "https://www.googleapis.com/youtube/v3/playlistItems"
      + "?part=contentDetails&maxResults=50"
      + "&playlistId=" + uploadsPlaylistId
      + (pageToken ? "&pageToken=" + pageToken : "")
      + "&key=" + API_KEY;
    var json = await fetchJson(url);
    var items = json.items || [];

    var reachedOlderVideo = false;
    for (var i = 0; i < items.length; i++) {
      var publishedAt = (items[i].contentDetails.videoPublishedAt || "").slice(0, 10);
      if (publishedAt && publishedAt < sinceDate) {
        reachedOlderVideo = true;
        break;
      }
      ids.push(items[i].contentDetails.videoId);
    }

    if (reachedOlderVideo || !json.nextPageToken || items.length === 0) break;
    pageToken = json.nextPageToken;
  }

  return ids;
}

// 영상 ID 목록으로 제목/업로드일/길이/통계를 가져온다.
// videos.list는 한 번에 최대 50개 ID까지만 받아준다. 그보다 많으면 50개씩 나눠서 여러 번 호출한다.
async function fetchVideoDetails(videoIds) {
  var all = [];
  for (var i = 0; i < videoIds.length; i += 50) {
    var chunk = videoIds.slice(i, i + 50);
    if (chunk.length === 0) continue;
    var url = "https://www.googleapis.com/youtube/v3/videos"
      + "?part=snippet,contentDetails,statistics"
      + "&id=" + chunk.join(",")
      + "&key=" + API_KEY;
    var json = await fetchJson(url);
    all = all.concat(json.items || []);
  }
  return all;
}

async function collectChannel(channelConfig, sinceDate) {
  var channel = await fetchChannelByHandle(channelConfig.handle);
  var videoIds = await fetchVideoIdsSince(channel.uploadsPlaylistId, sinceDate);
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

  var sinceDate = loadCollectSince();
  console.log(sinceDate + " 이후 업로드된 영상을 전체 수집합니다(개수 상한 없음).");

  var channels = JSON.parse(fs.readFileSync(CHANNELS_PATH, "utf8"));
  var rows = [];
  var failedHandles = [];

  // 채널 하나가 실패해도(예: 핸들 오류) 나머지 채널은 계속 수집한다.
  for (var i = 0; i < channels.length; i++) {
    try {
      var channelRows = await collectChannel(channels[i], sinceDate);
      rows = rows.concat(channelRows);
      console.log("완료: @" + channels[i].handle + " (" + channelRows.length + "개 영상)");
    } catch (err) {
      failedHandles.push(channels[i].handle);
      console.error("실패: @" + channels[i].handle + " → " + err.message);
    }
  }

  // 채널이 하나라도 등록돼 있는데 전부 실패했으면(예: API 키 제한/만료),
  // 겉으로는 "성공"인데 실제로는 아무것도 안 쌓이는 상황을 막기 위해 여기서 실패로 처리한다
  // — Actions 화면에 빨간 X로 떠야 바로 알아챌 수 있다.
  // (수집 대상 영상이 진짜로 0개라 rows가 비는 것과, 채널 조회 자체가 실패한 것은 구분한다.)
  if (channels.length > 0 && failedHandles.length === channels.length) {
    throw new Error(
      "모든 채널(" + failedHandles.length + "개) 수집 실패 → API 키/네트워크 문제일 가능성이 높습니다. "
      + "실패 목록: " + failedHandles.join(", ")
    );
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
