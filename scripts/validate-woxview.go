// Run from wox.core with a WoxView JSON document on stdin.
package main

import (
	"io"
	"os"
	"wox/ui/woxview"
)

func main() {
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		panic(err)
	}
	if _, err = woxview.Parse(data); err != nil {
		panic(err)
	}
}
