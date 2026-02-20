{
  lib,
  buildPythonApplication,
  setuptools,
  beautifulsoup4,
}:

buildPythonApplication {
  pname = "web-fetch";
  version = "1.0.0";
  pyproject = true;

  src = ./.;

  build-system = [ setuptools ];

  dependencies = [ beautifulsoup4 ];

  meta = with lib; {
    description = "CLI tool for fetching and extracting web content";
    license = licenses.mit;
    mainProgram = "web-fetch";
  };
}
