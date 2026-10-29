// Compiles the engine into one binary with Bun.
//
// Bundlers bake each module's `__dirname` / `__filename` / `import.meta.url` into the output
// as the *build machine's* absolute path. A dependency that reads files next to itself
// (the Feishu SDK reads its package.json for the User-Agent) then touches the build
// checkout at runtime — on a user's Mac a path that doesn't exist, and on the build Mac a
// Desktop folder that makes macOS ask for Desktop access before the engine has started.
// This plugin rewrites those three to a neutral path inside the binary's virtual FS.
//
//   bun scripts/bundle-engine.mjs <outfile> <bun target>
import path from "node:path";

const [outfile, target = "bun-darwin-arm64"] = process.argv.slice(2);
const root = path.resolve(import.meta.dir, "..");

const neutralPaths = {
  name: "neutral-paths",
  setup(build) {
    build.onLoad({ filter: /node_modules\/.*\.(c|m)?js$/ }, async (args) => {
      let text = await Bun.file(args.path).text();
      if (!/__dirname|__filename|import\.meta\.url/.test(text)) return undefined;
      const rel = path.relative(root, args.path);
      const fake = `/$bunfs/root/${rel}`;
      text = text
        .replace(/\b__dirname\b/g, JSON.stringify(path.dirname(fake)))
        .replace(/\b__filename\b/g, JSON.stringify(fake))
        .replace(/\bimport\.meta\.url\b/g, JSON.stringify(`file://${fake}`));
      return { contents: text, loader: "js" };
    });
  },
};

const result = await Bun.build({
  entrypoints: [path.join(root, "src", "main.js")],
  compile: { target, outfile, autoloadDotenv: false, autoloadBunfig: false },
  minify: true,
  plugins: [neutralPaths],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
