{
  description = "Agent toolkit — CLI tools and skills for LLM coding agents";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
  };

  outputs =
    inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];

      perSystem =
        {
          pkgs,
          self',
          lib,
          ...
        }:
        {
          checks =
            let
              packages = lib.mapAttrs' (n: lib.nameValuePair "package-${n}") self'.packages;
            in
            packages;

          packages = {
            browser-cli = pkgs.python3.pkgs.callPackage ./tools/browser-cli { };
            context7-cli = pkgs.python3.pkgs.callPackage ./tools/context7-cli { };
            gmaps-cli = pkgs.python3.pkgs.callPackage ./tools/gmaps-cli { };
            iroh-rpc = pkgs.callPackage ./tools/iroh-rpc { };
            kagi-search = pkgs.python3.pkgs.callPackage ./tools/kagi-search { };
            pexpect-cli = pkgs.callPackage ./tools/pexpect-cli { };
            screenshot-cli = pkgs.python3.pkgs.callPackage ./tools/screenshot-cli {
              spectacle =
                if pkgs.stdenv.hostPlatform.isLinux then pkgs.kdePackages.spectacle else null;
            };
            weather-cli = pkgs.python3.pkgs.callPackage ./tools/weather-cli { };
          };
        };
    };
}
