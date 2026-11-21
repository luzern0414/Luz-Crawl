"""Discovery fixtures are offline tests, never evidence of live research."""
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import crawl_preflight as crawl
from test_crawl_preflight import FAKE_CLI


class ResearchInventoryTests(unittest.TestCase):
    def test_new_candidate_records_cannot_conclude_without_review(self):
        from test_crawl_preflight import fixture
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path, value, _ = fixture(root)
            file = path.with_name(path.stem + '-candidates.json')
            crawl.write(file, {'candidates': [{'url': s['url']} for s in value['sources']]})
            value.update(candidate_inventory=file.name, candidate_inventory_sha256=crawl.digest(file))
            crawl.write(path, value)
            self.assertEqual(crawl.validate_preflight(root, 'luz-design', require_findings=False), [])
            self.assertTrue(any('尽责复盘' in error for error in crawl.validate_preflight(root, 'luz-design')))

    def test_review_binds_all_candidates_and_records_actual_decisions(self):
        from research_inventory import review_errors
        from test_research_coverage import handoff
        record, inventory, review, _ = handoff()
        self.assertEqual(review_errors(record, inventory, review), [])
        review['candidate_reviews'] = []
        self.assertTrue(any('候选' in e for e in review_errors(record, inventory, review)))
        review['candidate_inventory_sha256'] = 'old-hash'
        self.assertTrue(any('绑定' in e for e in review_errors(record, inventory, review)))
        review['experience_updates'] = [{'passed': True}]
        self.assertTrue(any('experience_updates' in e for e in review_errors(record, inventory, review)))

    def test_inventory_hash_is_checked_without_breaking_older_records(self):
        from test_crawl_preflight import fixture
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path, value, _ = fixture(root)
            self.assertEqual(crawl.validate_preflight(root, 'luz-design', require_findings=False), [])
            file = path.with_name(path.stem + '-candidates.json')
            crawl.write(file, {'candidates': []})
            value.update(candidate_inventory=file.name, candidate_inventory_sha256=crawl.digest(file))
            crawl.write(path, value)
            self.assertEqual(crawl.validate_preflight(root, 'luz-design', require_findings=False), [])
            crawl.write(file, {'candidates': ['changed']})
            self.assertTrue(any('候选清单' in error for error in crawl.validate_preflight(root, 'luz-design', require_findings=False)))

    def test_inventory_keeps_all_candidates_routes_and_body_boundary(self):
        module_path = Path(__file__).with_name('research_inventory.py')
        self.assertTrue(module_path.is_file(), 'Missing complete candidate inventory builder')
        spec = importlib.util.spec_from_file_location('research_inventory', module_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        candidates = [{'url': f'https://source{i}.example/page', 'text': f'Source {i}'} for i in range(125)]
        rows = [({'command': 'search', 'args': ['search', 'bing', 'core'], 'file': 'first.json'},
                 {'search_performed': True, 'candidates': candidates}),
                ({'command': 'search', 'args': ['search', 'bing', 'related'], 'file': 'second.json'},
                 {'search_performed': True, 'candidates': [{'url': 'https://source0.example/page?utm_source=index'}]}),
                ({'command': 'capture', 'args': ['capture', 'https://blocked.example/doc'], 'file': 'failed.json'},
                 {'status': 'blocked', 'stop_reason': 'verification_required'})]
        sources = [{'id': 'SRC-001', 'url': 'https://source1.example/page'}]
        result = module.build_inventory(rows, sources)
        self.assertEqual(len(result['candidates']), 126)
        self.assertEqual(len(result['sites']), 126)
        by_url = {c['url']: c for c in result['candidates']}
        self.assertEqual(len(by_url['https://source0.example/page']['routes']), 2)
        self.assertEqual(by_url['https://source0.example/page']['status'], 'candidate')
        self.assertEqual(by_url['https://source1.example/page']['status'], 'body-captured')
        self.assertEqual(by_url['https://blocked.example/doc']['status'], 'blocked')

    def test_discovery_can_run_without_reading_arbitrary_top_results(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cli = root / 'fake.mjs'
            cli.write_text(FAKE_CLI, encoding='utf-8')
            with patch.object(crawl, 'CLI', cli), patch.object(crawl, 'DEFAULT_OUTPUT', str(root / 'tasks')), patch.dict(os.environ, {'FAKE_LOG': str(root / 'calls.json')}):
                result = crawl.run(root, 'luz-crawl', 'broad topic', queries=['precise concept'], read_count=0)
            self.assertEqual(result['status'], 'needs-research')
            self.assertEqual(result['sources'], [])
            self.assertTrue(Path(result['candidate_inventory']).is_file())
            self.assertIn({'query': 'precise concept', 'platform': 'bing', 'notes': []}, crawl.read(result['experience_logs'][0])['lookups'])
            self.assertEqual(crawl.read(result['batch_file'])['results'][0]['read'], 0)
            self.assertTrue(crawl.validate_preflight(root, 'luz-crawl'), 'Candidate-only discovery cannot pass completion')

    def test_a_thrown_capture_preserves_other_discovery_in_the_same_batch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cli = root / 'fake.mjs'
            cli.write_text(FAKE_CLI, encoding='utf-8')
            failure = {'FAKE_LOG': str(root / 'calls.json'), 'FAKE_THROW': 'failed.example'}
            with patch.object(crawl, 'CLI', cli), patch.object(crawl, 'DEFAULT_OUTPUT', str(root / 'tasks')), patch.dict(os.environ, failure):
                result = crawl.run(root, 'luz-crawl', 'topic', queries=['concept'], urls=['https://failed.example/doc'], read_count=0)
            self.assertEqual(result['status'], 'needs-research')
            self.assertEqual(result['candidate_count'], 3)
            capture = next(step for step in crawl.read(result['record'])['steps'] if step['command'] == 'capture')
            self.assertEqual(capture['exit_code'], 1)
            self.assertEqual(crawl.read(capture['file'])['error'], 'Fixture capture failed')


if __name__ == '__main__':
    unittest.main()
