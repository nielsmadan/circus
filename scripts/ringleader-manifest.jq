$pins[0].ringleader as $pin
| .latest = $pin.version
| .wheel = "ringleader-\($pin.version)-py3-none-any.whl"
| .sha256 = ($pin.assets["ringleader-{version}-py3-none-any.whl"] | ltrimstr("sha256:"))
