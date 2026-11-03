import errno
import hashlib
import importlib.util
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock

spec=importlib.util.spec_from_file_location('installer',Path(__file__).with_name('2026-11-03-install-timers.py'))
installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)


def generation():
    contents={name:('synthetic '+name+'\n').encode() for name in installer.UNIT_HASHES}
    return contents,{name:hashlib.sha256(data).hexdigest() for name,data in contents.items()}


class GenerationTests(unittest.TestCase):
    def test_exact_generation_validates(self):
        contents,expected=generation()
        self.assertTrue(installer.validate_generation(contents,expected))

    def test_modified_missing_extra_traversal_or_oversize_units_refuse(self):
        contents,expected=generation();name=next(iter(contents))
        for changed in [{**contents,name:b'synthetic changed'}, {k:v for k,v in contents.items() if k!=name}, {**contents,'../synthetic':b'synthetic'}, {**contents,name:b'x'*16385}]:
            with self.subTest(keys=list(changed)):
                self.assertFalse(installer.validate_generation(changed,expected))


@unittest.skipUnless(os.name=='posix','real Unix file ownership and descriptor operations required')
class FilesystemTests(unittest.TestCase):
    def test_privileged_destination_refuses_operator_owned_directory(self):
        with tempfile.TemporaryDirectory(prefix='fcd-synthetic-timer-install-') as name:
            target=Path(name)/'destination';target.mkdir(mode=0o700)
            with self.assertRaises(RuntimeError):installer.root_destination(target)

    def test_install_writes_only_four_exact_mode_0644_files(self):
        contents,expected=generation()
        with tempfile.TemporaryDirectory(prefix='fcd-synthetic-timer-install-') as name:
            target=Path(name)/'destination';target.mkdir(mode=0o700)
            installer.install_generation(target,contents,expected)
            self.assertEqual(set(p.name for p in target.iterdir()),set(contents))
            for unit,data in contents.items():
                self.assertEqual((target/unit).read_bytes(),data)
                self.assertEqual(stat.S_IMODE((target/unit).stat().st_mode),0o644)

    def test_collision_refuses_before_any_write_and_preserves_existing_file(self):
        contents,expected=generation()
        with tempfile.TemporaryDirectory(prefix='fcd-synthetic-timer-install-') as name:
            target=Path(name)/'destination';target.mkdir(mode=0o700)
            unit=next(iter(contents));(target/unit).write_bytes(b'synthetic existing')
            with self.assertRaises(RuntimeError):installer.install_generation(target,contents,expected)
            self.assertEqual(list(p.name for p in target.iterdir()),[unit])
            self.assertEqual((target/unit).read_bytes(),b'synthetic existing')

    def test_symlink_destination_refuses_without_writing_through_it(self):
        contents,expected=generation()
        with tempfile.TemporaryDirectory(prefix='fcd-synthetic-timer-install-') as name:
            target=Path(name)/'real';target.mkdir(mode=0o700)
            alias=Path(name)/'alias';alias.symlink_to(target,target_is_directory=True)
            with self.assertRaises(RuntimeError):installer.install_generation(alias,contents,expected)
            self.assertEqual(list(target.iterdir()),[])

    def test_partial_enospc_rolls_back_only_its_own_created_files(self):
        contents,expected=generation();second=list(contents)[1];real_open=os.open
        with tempfile.TemporaryDirectory(prefix='fcd-synthetic-timer-install-') as name:
            target=Path(name)/'destination';target.mkdir(mode=0o700)
            marker=target/'synthetic_unrelated';marker.write_bytes(b'synthetic retained')
            def failing_open(path,flags,*args,**kwargs):
                if str(path)==second and flags&os.O_CREAT:raise OSError(errno.ENOSPC,'synthetic full')
                return real_open(path,flags,*args,**kwargs)
            with mock.patch.object(installer.os,'open',side_effect=failing_open),self.assertRaises(OSError):installer.install_generation(target,contents,expected)
            self.assertEqual(list(p.name for p in target.iterdir()),['synthetic_unrelated'])
            self.assertEqual(marker.read_bytes(),b'synthetic retained')

    def prepared(self,root):
        contents,expected=generation();source=Path(root)/'source';source.mkdir(mode=0o700)
        for name,data in contents.items():
            (source/name).write_bytes(data);os.chmod(source/name,0o600)
        return source,contents,expected

    def test_reads_exact_protected_generation(self):
        with tempfile.TemporaryDirectory(prefix='fcd-synthetic-timer-install-') as root:
            source,contents,expected=self.prepared(root)
            self.assertEqual(installer.read_generation(source,expected),contents)

    def test_source_symlink_hardlink_and_nonprivate_mode_refuse(self):
        for fault in ['symlink','hardlink','mode']:
            with self.subTest(fault=fault),tempfile.TemporaryDirectory(prefix='fcd-synthetic-timer-install-') as root:
                source,contents,expected=self.prepared(root);unit=next(iter(contents));path=source/unit
                if fault=='symlink':
                    other=Path(root)/'synthetic_other';path.rename(other);path.symlink_to(other)
                elif fault=='hardlink':os.link(path,Path(root)/'synthetic_other')
                else:os.chmod(path,0o644)
                with self.assertRaises(RuntimeError):installer.read_generation(source,expected)


if __name__=='__main__':unittest.main()
