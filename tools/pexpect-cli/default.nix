{
  python3,
  pueue,
}:
python3.pkgs.buildPythonApplication {
  pname = "pexpect-cli";
  version = "0.1.0";
  pyproject = true;

  src = ./.;

  build-system = with python3.pkgs; [
    setuptools
    wheel
  ];

  dependencies = with python3.pkgs; [ pexpect ];

  doCheck = false;

  makeWrapperArgs = [ "--prefix PATH : ${pueue}/bin" ];

  postPatch = ''
    patchShebangs bin/
  '';

  preCheck = ''
    export PATH=$out/bin:${pueue}/bin:$PATH
  '';

  pythonImportsCheck = [ "pexpect_cli" ];

  meta = {
    description = "Persistent pexpect sessions via pueue";
    mainProgram = "pexpect-cli";
  };
}
