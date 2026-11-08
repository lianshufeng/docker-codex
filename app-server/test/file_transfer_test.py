import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from file_transfer import FileTransfers, CHUNK_BYTES


class FileTransferTests(unittest.TestCase):
    def test_restart_duplicate_and_atomic_commit_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'attachments').mkdir()
            transfer_id = str(uuid.uuid4())
            request = {'root': str(root), 'transferId': transfer_id}
            relative = f'attachments/{transfer_id}-中文.bin'
            payload = bytes([37]) * CHUNK_BYTES
            digest = hashlib.sha256(payload).hexdigest()
            engine = FileTransfers()
            engine.execute(request | {'op': 'begin', 'relative': relative, 'name': '中文.bin', 'size': len(payload), 'image': False}, b'')
            engine.execute(request | {'op': 'write', 'offset': 0, 'sha256': digest}, payload)
            restarted = FileTransfers()
            metadata, _ = restarted.execute(request | {'op': 'status'}, b'')
            self.assertEqual(metadata['offset'], len(payload))
            restarted.execute(request | {'op': 'write', 'offset': 0, 'sha256': digest}, payload)
            with self.assertRaisesRegex(ValueError, '不一致'):
                restarted.execute(request | {'op': 'write', 'offset': 0, 'sha256': hashlib.sha256(b'x' * CHUNK_BYTES).hexdigest()}, b'x' * CHUNK_BYTES)
            # Simulate a crash immediately after renaming the part file.
            part = root / 'attachments' / f'.web-upload-{transfer_id}.part'
            part.replace(root / relative)
            metadata, _ = FileTransfers().execute(request | {'op': 'finish'}, b'')
            self.assertTrue(metadata['complete'])
            self.assertEqual(metadata['sha256'], digest)

    def test_path_and_invalid_block_do_not_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'attachments').mkdir()
            engine = FileTransfers()
            request = {'root': str(root), 'transferId': str(uuid.uuid4())}
            with self.assertRaisesRegex(ValueError, '路径'):
                engine.execute(request | {'op': 'open', 'relative': '../private'}, b'')
            engine.execute(request | {'op': 'begin', 'relative': 'attachments/test.bin', 'name': 'test', 'size': 129 * 1024 * 1024, 'image': False}, b'')
            (root / 'attachments' / f'.web-upload-{request["transferId"]}.json').unlink()
            (root / 'attachments' / f'.web-upload-{request["transferId"]}.part').unlink()
            engine.execute(request | {'op': 'begin', 'relative': 'attachments/test.bin', 'name': 'test', 'size': 1, 'image': False}, b'')
            with self.assertRaisesRegex(ValueError, '校验'):
                engine.execute(request | {'op': 'write', 'offset': 0, 'sha256': 'wrong'}, b'x')
            with self.assertRaisesRegex(ValueError, '尚未完成'):
                engine.execute(request | {'op': 'finish'}, b'')
            self.assertFalse((root / 'attachments/test.bin').exists())


if __name__ == '__main__':
    unittest.main()
