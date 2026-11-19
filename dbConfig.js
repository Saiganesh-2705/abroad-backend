// Helpers that turn the most common MongoDB Atlas setup mistakes into clear messages (and fix the ones that can be fixed safely).

const isPlaceholder = (uri) => {
  const rest = uri.replace(/^mongodb(\+srv)?:\/\//, "");
  const host = rest.slice(rest.lastIndexOf("@") + 1).split(/[/?]/)[0];
  const creds = rest.includes("@") ? rest.slice(0, rest.lastIndexOf("@")).split(":") : [];
  return /<[^>]+>/.test(rest) || /^(CLUSTER|HOST|YOUR[-_A-Z]*)(\.|$)/i.test(host) || creds.some((c) => ["USER", "PASSWORD", "DB_USER", "DB_PASSWORD"].includes(c));
};

/** Returns { uri, problem }. `problem` is a human sentence when the URI cannot work yet. */
export function prepareUri(raw) {
  let uri = String(raw || "").trim().replace(/^['"]|['"]$/g, "");
  if (!uri) return { uri: "", problem: "MONGODB_URI is empty. Paste your Atlas connection string into backend/.env." };
  if (!/^mongodb(\+srv)?:\/\//.test(uri)) return { uri, problem: "MONGODB_URI must start with mongodb+srv:// or mongodb://" };
  if (isPlaceholder(uri))
    return { uri, problem: "MONGODB_URI still contains a placeholder (such as CLUSTER). In Atlas open Database > Connect > Drivers, copy the real string (host looks like cluster0.ab1cd.mongodb.net) and paste it into backend/.env." };

  // Encode special characters in the username / password so '@', ':' or '/' in a password cannot break the URI.
  const m = uri.match(/^(mongodb(?:\+srv)?:\/\/)([^:/@]+):(.*)@([^@]+)$/);
  if (m) {
    const safe = (s) => { try { return encodeURIComponent(decodeURIComponent(s)); } catch { return encodeURIComponent(s); } };
    uri = `${m[1]}${safe(m[2])}:${safe(m[3])}@${m[4]}`;
  }
  // Default database name when the string has none (…mongodb.net/?options  or  …mongodb.net).
  uri = uri.replace(/^((?:mongodb(?:\+srv)?:\/\/)[^/?]+)(\/?)(\?|$)/, (_s, host, _slash, q) => `${host}/algebra${q}`);
  return { uri, problem: "" };
}

/** Plain-English hint for a connection error. */
export function explain(message = "") {
  if (/querySrv|ENOTFOUND/.test(message)) return "DNS could not find the cluster host. Check the host name in MONGODB_URI (copy it again from Atlas) and your internet/DNS.";
  if (/ECONNREFUSED/.test(message)) return "The connection was refused. Try another network, or use Atlas's non-SRV 'mongodb://' string (Connect > Drivers > older driver version).";
  if (/bad auth|Authentication failed|auth/i.test(message)) return "Wrong database username or password. Atlas > Database Access: check the user, or reset its password (letters and digits only is easiest).";
  if (/whitelist|not allowed|IP|Server selection timed out|ReplicaSetNoPrimary/i.test(message)) return "Atlas is blocking this IP. Atlas > Network Access > Add IP Address > Allow access from anywhere (0.0.0.0/0), wait a minute, then retry.";
  return "";
}
