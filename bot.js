const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const fs = require("fs");

// ─── CONFIG ────────────────────────────────────────────────────────────────
const BOT_TOKEN        = process.env.BOT_TOKEN;
const RESULTS_CHANNEL  = process.env.RESULTS_CHANNEL;   // channel ID where YOU type !results
const ANNOUNCE_CHANNEL = process.env.ANNOUNCE_CHANNEL;  // channel ID where winners are posted
const ADMIN_USER_IDS   = process.env.ADMIN_USER_IDS     // comma-separated Discord user IDs (optional – restricts !results to these users)
  ? process.env.ADMIN_USER_IDS.split(",").map(id => id.trim())
  : [];
const DATA_FILE        = "./parlays.json";
// ───────────────────────────────────────────────────────────────────────────

const matchups = [
  ["Dirty Little Leprechauns", "Bandit and Sons"],
  ["MDVYN Maulers", "New Port Jets"],
  ["Shanghai Squirters", "Silent Jay's Super Buys"],
  ["Yolks Bouncing Buys", "Queens Wild"],
  ["Baker King's Lucky Lines", "Bass Fish Fingers"],
  ["Dave's Stickier Wilds", "New England Paytriots"],
  ["No Limit Soljah", "Starnate Princess"],
];

// ─── STORAGE ───────────────────────────────────────────────────────────────
function loadParlays() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return []; }
}

function saveParlays(parlays) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(parlays, null, 2));
}

function addParlay(name, picks) {
  const parlays = loadParlays();
  // Replace existing entry for same name (case-insensitive)
  const idx = parlays.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
  const entry = { name, picks, submittedAt: new Date().toISOString() };
  if (idx >= 0) parlays[idx] = entry;
  else parlays.push(entry);
  saveParlays(parlays);
}

// ─── BOT ───────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", () => {
  console.log(`✅ GSL Bot online as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // ── Incoming webhook parlay (forwarded by the website via a second webhook or manual paste)
  // The bot also listens for !addparlay for testing:
  // !addparlay Name | Team1, Team2, Team3, Team4, Team5, Team6, Team7
  if (message.content.startsWith("!addparlay")) {
    const body = message.content.slice("!addparlay".length).trim();
    const [name, picksRaw] = body.split("|").map(s => s.trim());
    if (!name || !picksRaw) {
      return message.reply("Usage: `!addparlay Name | Pick1, Pick2, Pick3, Pick4, Pick5, Pick6, Pick7`");
    }
    const picks = picksRaw.split(",").map(p => p.trim());
    if (picks.length !== matchups.length) {
      return message.reply(`Need exactly ${matchups.length} picks, got ${picks.length}.`);
    }
    addParlay(name, picks);
    return message.reply(`✅ Parlay saved for **${name}**!`);
  }

  // ── Results command
  // Usage: !results Team1, Team2, Team3, Team4, Team5, Team6, Team7
  if (message.content.startsWith("!results")) {
    // Optional: restrict to admins only
    if (ADMIN_USER_IDS.length > 0 && !ADMIN_USER_IDS.includes(message.author.id)) {
      return message.reply("❌ Only league admins can enter results.");
    }
    if (message.channel.id !== RESULTS_CHANNEL) {
      return message.reply(`❌ Use this command in the designated results channel.`);
    }

    const raw = message.content.slice("!results".length).trim();
    const winners = raw.split(",").map(w => w.trim());

    if (winners.length !== matchups.length) {
      return message.reply(
        `❌ Need exactly ${matchups.length} results, got ${winners.length}.\n` +
        `Usage: \`!results Team1, Team2, Team3, Team4, Team5, Team6, Team7\``
      );
    }

    // Validate each winner is a real team in the correct matchup
    for (let i = 0; i < matchups.length; i++) {
      const [a, b] = matchups[i];
      if (winners[i] !== a && winners[i] !== b) {
        return message.reply(
          `❌ Game ${i + 1}: "${winners[i]}" isn't a valid team.\n` +
          `Options: **${a}** or **${b}**`
        );
      }
    }

    // Score all parlays
    const parlays = loadParlays();
    if (parlays.length === 0) {
      return message.reply("⚠️ No parlays on file for this day.");
    }

    const results = parlays.map(p => {
      let correct = 0;
      const breakdown = p.picks.map((pick, i) => {
        const hit = pick === winners[i];
        if (hit) correct++;
        return { game: i + 1, pick, winner: winners[i], hit };
      });
      return { name: p.name, correct, breakdown, perfect: correct === matchups.length };
    });

    const perfect = results.filter(r => r.perfect);
    const sorted  = [...results].sort((a, b) => b.correct - a.correct);
    const top     = sorted[0];

    // Build the announcement embed
    const announceChannel = await client.channels.fetch(ANNOUNCE_CHANNEL).catch(() => null);
    if (!announceChannel) {
      return message.reply("❌ Couldn't find the announce channel. Check ANNOUNCE_CHANNEL in your env.");
    }

    // ── Results summary embed
    const resultsEmbed = new EmbedBuilder()
      .setTitle("📊 GSL Day 5 — Official Results")
      .setColor(0xd4a843)
      .setDescription(
        winners.map((w, i) => `**Game ${i + 1}:** ${w}`).join("\n")
      )
      .setTimestamp();

    await announceChannel.send({ embeds: [resultsEmbed] });

    // ── Perfect parlays
    if (perfect.length > 0) {
      const perfectEmbed = new EmbedBuilder()
        .setTitle("🏆 PERFECT PARLAY!")
        .setColor(0x00e676)
        .setDescription(
          perfect.map(r => `🎯 **${r.name}** went **7/7!**`).join("\n") +
          "\n\n💰 Tip incoming on Rainbet!"
        )
        .setTimestamp();
      await announceChannel.send({ embeds: [perfectEmbed] });
    }

    // ── Leaderboard embed (top 5)
    const leaderboard = sorted.slice(0, 5).map((r, i) => {
      const medal = ["🥇","🥈","🥉","4️⃣","5️⃣"][i];
      return `${medal} **${r.name}** — ${r.correct}/${matchups.length}`;
    }).join("\n");

    const lbEmbed = new EmbedBuilder()
      .setTitle("📋 Day 5 Leaderboard")
      .setColor(0x3a9fd8)
      .setDescription(leaderboard)
      .setFooter({ text: `${parlays.length} total submissions` })
      .setTimestamp();

    await announceChannel.send({ embeds: [lbEmbed] });

    // ── Individual breakdowns (sent as one message per person, collapsed)
    const breakdownLines = sorted.map(r => {
      const bar = r.breakdown.map(b => b.hit ? "✅" : "❌").join(" ");
      return `**${r.name}** ${bar} (${r.correct}/${matchups.length})`;
    }).join("\n");

    const breakdownEmbed = new EmbedBuilder()
      .setTitle("🗂️ Full Breakdown")
      .setColor(0x555555)
      .setDescription(breakdownLines)
      .setTimestamp();

    await announceChannel.send({ embeds: [breakdownEmbed] });

    return message.reply(`✅ Results posted to <#${ANNOUNCE_CHANNEL}>!`);
  }

  // ── Help
  if (message.content === "!gslhelp") {
    return message.reply(
      "**GSL Bot Commands**\n" +
      "`!results Team1, Team2, ...` — Enter official results (admin only)\n" +
      "`!addparlay Name | Pick1, Pick2, ...` — Manually add a parlay (for testing)\n" +
      "`!gslhelp` — Show this message"
    );
  }
});

// ─── WEBHOOK RECEIVER ──────────────────────────────────────────────────────
// The website POSTs to Discord's webhook. To also save to the bot's JSON store,
// we parse the webhook messages as they arrive in the submissions channel.
// Add the submissions channel ID to env as SUBMISSIONS_CHANNEL.
const SUBMISSIONS_CHANNEL = process.env.SUBMISSIONS_CHANNEL;

if (SUBMISSIONS_CHANNEL) {
  client.on("messageCreate", async (message) => {
    if (message.channel.id !== SUBMISSIONS_CHANNEL) return;
    if (!message.author.bot) return; // Only process webhook/bot messages

    // Parse the format sent by the website:
    // 📋 **New Parlay Submission**
    // 👤 Name
    //
    // Game 1: Team
    // Game 2: Team ...
    const content = message.content;
    if (!content.includes("New Parlay Submission")) return;

    const nameMatch = content.match(/👤\s+(.+)/);
    if (!nameMatch) return;
    const name = nameMatch[1].trim();

    const picks = [];
    for (let i = 1; i <= matchups.length; i++) {
      const m = content.match(new RegExp(`Game ${i}: (.+)`));
      if (m) picks.push(m[1].trim());
    }

    if (picks.length === matchups.length) {
      addParlay(name, picks);
      console.log(`📥 Saved parlay from webhook: ${name}`);
    }
  });
}

client.login(BOT_TOKEN);
