{
  lib,
  buildPythonApplication,
  setuptools,
}:

buildPythonApplication {
  pname = "weather-cli";
  version = "1.0.0";
  pyproject = true;

  src = ./.;

  build-system = [ setuptools ];

  meta = with lib; {
    description = "CLI tool for weather forecasts using Bright Sky API (DWD/MOSMIX, worldwide)";
    license = licenses.mit;
    mainProgram = "weather-cli";
  };
}
