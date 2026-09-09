{
  description = "draw: self-hosted Excalidraw+ on the upstream excalidraw.com editor";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "aarch64-linux"
        "x86_64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      version = "0.1.0-${self.shortRev or self.dirtyShortRev or "dev"}";
    in
    {
      packages = forAllSystems (
        pkgs:
        let
          inherit (pkgs) lib;
          webSrc = lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.difference (lib.fileset.gitTracked ./.) (
              lib.fileset.unions [
                (lib.fileset.maybeMissing ./server)
                (lib.fileset.maybeMissing ./nix)
                (lib.fileset.maybeMissing ./flake.lock)
                ./flake.nix
                ./SPEC.md
                ./AGENTS.md
              ]
            );
          };
          web = pkgs.stdenv.mkDerivation {
            pname = "draw-web";
            inherit version;
            src = webSrc;
            nativeBuildInputs = [
              pkgs.nodejs_24
              pkgs.yarnConfigHook
              pkgs.yarnBuildHook
            ];
            offlineCache = pkgs.fetchYarnDeps {
              yarnLock = "${webSrc}/yarn.lock";
              hash = "sha256-Fib09SBYwALGpa00t+f+xyFGbu+6hxIUME2M5wN6+5o=";
            };
            yarnBuildScript = "build:app:docker";
            env.VITE_APP_GIT_SHA = self.shortRev or self.dirtyShortRev or "dev";
            installPhase = ''
              runHook preInstall
              cp -r excalidraw-app/build $out
              runHook postInstall
            '';
          };
          server = pkgs.buildGoModule {
            pname = "draw";
            inherit version;
            src = ./server;
            vendorHash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
            subPackages = [ "cmd/draw" ];
            ldflags = [
              "-s"
              "-w"
              "-X main.version=${version}"
            ];
            preBuild = ''
              rm -rf web/dist
              cp -r ${web} web/dist
              chmod -R u+w web/dist
            '';
            passthru = {
              inherit web;
            };
            meta = {
              description = "Self-hosted Excalidraw+: the excalidraw.com editor with a Go backend";
              homepage = "https://git.harivan.sh/harivansh-afk/draw";
              license = lib.licenses.mit;
              mainProgram = "draw";
            };
          };
        in
        {
          inherit web server;
          default = server;
        }
      );

      nixosModules.default = import ./nix/module.nix { inherit self; };

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_24
            pkgs.yarn
            pkgs.go
            pkgs.gopls
            pkgs.sqlite
          ];
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree);
    };
}
