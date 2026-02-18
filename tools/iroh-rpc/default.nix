{
  lib,
  rustPlatform,
  pkg-config,
  openssl,
}:

rustPlatform.buildRustPackage {
  pname = "iroh-rpc";
  version = "0.1.1";

  src = ./.;

  cargoHash = "sha256-bCNb4gY9/ULy/PAOj9qUuK8I9yXTUGBmE3YgyZmGUu4=";

  nativeBuildInputs = [ pkg-config ];
  buildInputs = [ openssl ];

  meta = {
    description = "P2P RPC daemon for AI agent swarms using iroh/irpc QUIC networking";
    mainProgram = "iroh-rpc";
    license = lib.licenses.mit;
    maintainers = [ ];
  };
}
