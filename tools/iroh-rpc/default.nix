{
  lib,
  rustPlatform,
  pkg-config,
  openssl,
}:

rustPlatform.buildRustPackage {
  pname = "iroh-rpc";
  version = "0.1.0";

  src = ./.;

  cargoHash = "sha256-ZdO7q/J29QzWIaVXrMkjdbe9D396GEPI31ki5TfYQgQ=";

  nativeBuildInputs = [ pkg-config ];
  buildInputs = [ openssl ];

  meta = {
    description = "P2P RPC daemon for AI agent swarms using iroh/irpc QUIC networking";
    mainProgram = "iroh-rpc";
    license = lib.licenses.mit;
    maintainers = [ ];
  };
}
