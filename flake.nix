{
  description = "System dependencies for agent";

  inputs = {
    # Make sure to use the same locked commits as the nix-infra deploys
    # That way the packages are shared
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      b = builtins;
      # Make sure that this include runtime libs linked by npm builds
      deps = pkgs:
        with pkgs; [
          bashInteractive
          # NodeJS
          nodejs_20
          corepack_20
        ];
      makeDevShell = system: pkgs: {
        default = pkgs.mkShell {
          nativeBuildInputs = (deps pkgs) ++ (with pkgs; [ gitMinimal ]);
          shellHook = ''
            export PATH=$PWD/node_modules/.bin:$PATH
          '';
        };
      };
    in { devShells = b.mapAttrs (makeDevShell) nixpkgs.legacyPackages; };
}
