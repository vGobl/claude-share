export interface ConnectArgs {
  share?: string;
  reconnect?: string;
  list: boolean;
  claudeArgs: string[];
}
export function parseArgs(args: string[]): ConnectArgs {
  const result: ConnectArgs = { list: false, claudeArgs: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      result.claudeArgs.push(...args.slice(i + 1));
      break;
    }
    if (a === "--share" || a.startsWith("--share=")) {
      const value = a === "--share" ? args[++i] : a.slice(8);
      if (!value || value.startsWith("-")) throw new Error("--share requires a connect URL");
      result.share = value;
    } else if (a === "--list" || a === "-l") result.list = true;
    else if (a === "--reconnect" || a === "-r") {
      result.reconnect = args[i + 1] && !args[i + 1].startsWith("-") ? args[++i] : "";
    } else if (a === "--cleanup")
      throw new Error("--cleanup is not supported; expired connections are removed automatically");
    else result.claudeArgs.push(a);
  }
  if (
    [result.share !== undefined, result.reconnect !== undefined, result.list].filter(Boolean)
      .length > 1
  )
    throw new Error("Choose only one of --share, --reconnect or --list");
  return result;
}
