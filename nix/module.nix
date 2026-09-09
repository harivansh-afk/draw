{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.draw;
  inherit (lib)
    mkEnableOption
    mkOption
    mkPackageOption
    mkIf
    types
    ;
in
{
  options.services.draw = {
    enable = mkEnableOption "draw, the self-hosted Excalidraw+";

    package = mkPackageOption self.packages.${pkgs.stdenv.hostPlatform.system} "server" { };

    listen = mkOption {
      type = types.str;
      default = "127.0.0.1:34729";
      description = "Address the HTTP server binds to.";
    };

    baseUrl = mkOption {
      type = types.str;
      example = "https://draw.example.com";
      description = "Public origin, used for OIDC redirects, cookies and CSRF checks.";
    };

    allowedEmails = mkOption {
      type = types.listOf types.str;
      default = [ ];
      description = "Accounts allowed to sign in. Empty means the first account to sign in becomes the only allowed one.";
    };

    openSignup = mkOption {
      type = types.bool;
      default = false;
      description = "Let any verified account sign in.";
    };

    trustProxy = mkOption {
      type = types.bool;
      default = true;
      description = "Read the client IP from X-Forwarded-For.";
    };

    environmentFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      description = "systemd EnvironmentFile with OIDC_CLIENT_ID and OIDC_CLIENT_SECRET.";
    };

    environment = mkOption {
      type = types.attrsOf types.str;
      default = { };
      description = "Extra environment variables (DRAW_* or OIDC_*).";
    };

    backup = {
      enable = mkEnableOption "nightly SQLite backups";
      directory = mkOption {
        type = types.str;
        default = "/var/backup/draw";
      };
      retentionDays = mkOption {
        type = types.int;
        default = 14;
      };
      onCalendar = mkOption {
        type = types.str;
        default = "*-*-* 04:00:00 UTC";
      };
    };
  };

  config = mkIf cfg.enable {
    users.users.draw = {
      isSystemUser = true;
      group = "draw";
      home = "/var/lib/draw";
    };
    users.groups.draw = { };

    systemd.services.draw = {
      description = "draw (self-hosted Excalidraw+)";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      environment = {
        DRAW_LISTEN = cfg.listen;
        DRAW_DATA_DIR = "/var/lib/draw";
        DRAW_BASE_URL = cfg.baseUrl;
        DRAW_ALLOWED_EMAILS = lib.concatStringsSep "," cfg.allowedEmails;
        DRAW_OPEN_SIGNUP = if cfg.openSignup then "1" else "0";
        DRAW_TRUST_PROXY = if cfg.trustProxy then "1" else "0";
      }
      // cfg.environment;
      serviceConfig = {
        User = "draw";
        Group = "draw";
        StateDirectory = "draw";
        StateDirectoryMode = "0700";
        WorkingDirectory = "/var/lib/draw";
        ExecStart = "${lib.getExe cfg.package} serve";
        EnvironmentFile = lib.optional (cfg.environmentFile != null) cfg.environmentFile;
        Restart = "on-failure";
        RestartSec = 2;
        UMask = "0077";
        NoNewPrivileges = true;
        PrivateDevices = true;
        PrivateTmp = true;
        ProtectControlGroups = true;
        ProtectHome = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        ProtectKernelLogs = true;
        ProtectClock = true;
        ProtectHostname = true;
        ProtectProc = "invisible";
        ProtectSystem = "strict";
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        MemoryDenyWriteExecute = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = [
          "@system-service"
          "~@privileged"
        ];
        CapabilityBoundingSet = "";
        AmbientCapabilities = "";
      };
    };

    systemd.services.draw-backup = mkIf cfg.backup.enable {
      description = "Back up the draw SQLite database";
      serviceConfig = {
        Type = "oneshot";
        User = "draw";
        Group = "draw";
        UMask = "0077";
        ReadWritePaths = [ cfg.backup.directory ];
      };
      path = [
        pkgs.coreutils
        pkgs.findutils
        pkgs.sqlite
      ];
      script = ''
        out="${cfg.backup.directory}/$(date -u +%Y-%m-%dT%H-%M-%SZ).sqlite"
        ${lib.getExe cfg.package} backup "$out"
        test "$(sqlite3 "$out" 'PRAGMA quick_check;')" = ok
        find ${cfg.backup.directory} -maxdepth 1 -type f -name '*.sqlite' -mtime +${toString cfg.backup.retentionDays} -delete
      '';
    };

    systemd.timers.draw-backup = mkIf cfg.backup.enable {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = cfg.backup.onCalendar;
        Persistent = true;
      };
    };

    systemd.tmpfiles.rules = mkIf cfg.backup.enable [
      "d ${cfg.backup.directory} 0700 draw draw -"
    ];
  };
}
