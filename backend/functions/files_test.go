package functions

import (
	"os"
	"path/filepath"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/openshift/faas-console-plugin/backend/scm"
)

var _ = Describe("collectFiles", func() {
	It("returns regular files with mode 100644", func() {
		dir := GinkgoT().TempDir()
		Expect(os.WriteFile(filepath.Join(dir, "hello.go"), []byte("package main"), 0644)).To(Succeed())

		files, err := collectFiles(dir)

		Expect(err).NotTo(HaveOccurred())
		Expect(files).To(HaveLen(1))
		Expect(files[0].Path).To(Equal("hello.go"))
		Expect(files[0].Content).To(Equal("package main"))
		Expect(files[0].Mode).To(Equal("100644"))
		Expect(files[0].Type).To(Equal("blob"))
	})

	It("marks executable files with mode 100755", func() {
		dir := GinkgoT().TempDir()
		Expect(os.WriteFile(filepath.Join(dir, "run.sh"), []byte("#!/bin/sh"), 0755)).To(Succeed())

		files, err := collectFiles(dir)

		Expect(err).NotTo(HaveOccurred())
		Expect(files).To(HaveLen(1))
		Expect(files[0].Mode).To(Equal("100755"))
	})

	It("marks symlinks with mode 120000", func() {
		dir := GinkgoT().TempDir()
		target := filepath.Join(dir, "target.go")
		Expect(os.WriteFile(target, []byte("package main"), 0644)).To(Succeed())
		Expect(os.Symlink(target, filepath.Join(dir, "link.go"))).To(Succeed())

		files, err := collectFiles(dir)

		Expect(err).NotTo(HaveOccurred())
		var link *scm.FileEntry
		for i := range files {
			if files[i].Path == "link.go" {
				link = &files[i]
			}
		}
		Expect(link).NotTo(BeNil())
		Expect(link.Mode).To(Equal("120000"))
	})

	It("skips directories and returns only file entries", func() {
		dir := GinkgoT().TempDir()
		subdir := filepath.Join(dir, "subdir")
		Expect(os.Mkdir(subdir, 0755)).To(Succeed())
		Expect(os.WriteFile(filepath.Join(subdir, "nested.go"), []byte("package sub"), 0644)).To(Succeed())

		files, err := collectFiles(dir)

		Expect(err).NotTo(HaveOccurred())
		Expect(files).To(HaveLen(1))
		Expect(files[0].Path).To(Equal(filepath.Join("subdir", "nested.go")))
	})

	It("returns paths relative to the root", func() {
		dir := GinkgoT().TempDir()
		nested := filepath.Join(dir, "a", "b")
		Expect(os.MkdirAll(nested, 0755)).To(Succeed())
		Expect(os.WriteFile(filepath.Join(nested, "file.go"), []byte("x"), 0644)).To(Succeed())

		files, err := collectFiles(dir)

		Expect(err).NotTo(HaveOccurred())
		Expect(files[0].Path).To(Equal(filepath.Join("a", "b", "file.go")))
	})

	It("returns an error when the root does not exist", func() {
		_, err := collectFiles("/nonexistent/path/that/cannot/exist")

		Expect(err).To(HaveOccurred())
	})
})
