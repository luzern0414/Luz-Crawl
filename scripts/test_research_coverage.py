"""Offline counterexamples: sufficient counts cannot hide an uncovered question."""
import copy
import unittest
from research_inventory import review_errors


def handoff():
    record = dict(caller='luz-dev', stage='review', task_root='task', candidate_inventory_sha256='hash',
                  sources=[{'id': 'SRC-1', 'url': 'https://example.org/doc'}],
                  steps=[{'command': 'search', 'exit_code': 0, 'args': ['search', 'bing', f'direction {i}']} for i in range(5)])
    inventory = {'candidates': [{'url': 'https://example.org/doc', 'status': 'body-captured', 'source_ids': ['SRC-1']}]}
    review = {key: record[key] for key in ('caller', 'stage', 'task_root', 'candidate_inventory_sha256')}
    review.update(questions=[{'id': 'Q1', 'question': 'Evidence?', 'importance': 'required'}],
                  query_groups=[{'purpose': f'direction {i}', 'queries': [f'direction {i}']} for i in range(5)],
                  candidate_reviews=[dict(url='https://example.org/doc', category='official', question_ids=['Q1'],
                                          status='read-adopted', priority='high', reason='Offline adopted fixture')],
                  rounds=[dict(logs=['offline'], observation='fixture', next_action='check')],
                  experience_reuse=[dict(status='no-hit', log='offline', impact='fixture')],
                  experience_updates=[dict(key='offline', category='method', outcome='unverified', evidence=['offline'], recall_log='offline')],
                  stop=dict(reason='sufficient', basis='Fixture only', remaining=[]))
    payload = dict(findings=[dict(id='F1', source_id='SRC-1', adopted=True)],
                   coverage=[dict(question_id='Q1', question='Evidence?', finding_ids=['F1'])])
    return record, inventory, review, payload


class ResearchCoverageTests(unittest.TestCase):
    def errors(self, data):
        record, inventory, review, payload = data
        return review_errors(record, inventory, review, payload=payload)

    def test_complete_shape_is_accepted_without_claiming_semantics(self):
        self.assertEqual(self.errors(handoff()), [])

    def test_missing_required_question_is_rejected(self):
        data = handoff()
        data[2]['questions'].append(dict(id='Q2', question='Recovery?', importance='required'))
        self.assertTrue(any('Q2' in e and '覆盖' in e for e in self.errors(data)))

    def test_adopted_link_without_body_is_rejected(self):
        data = handoff()
        data[0]['sources'] = []
        data[1]['candidates'][0].update(status='candidate', source_ids=[])
        self.assertTrue(any('正文' in e for e in self.errors(data)))

    def test_sufficient_cannot_leave_high_priority_unread(self):
        data = handoff()
        data[2]['candidate_reviews'][0]['status'] = 'unread'
        self.assertTrue(any('高优先级' in e for e in self.errors(data)))

    def test_query_groups_must_bind_distinct_actual_queries(self):
        for mutate in ('one-group', 'unexecuted', 'repeated'):
            data = handoff()
            groups = data[2]['query_groups']
            if mutate == 'one-group':
                data[2]['query_groups'] = groups[:1]
            elif mutate == 'unexecuted':
                groups[0]['queries'] = ['invented search']
            else:
                data[2]['query_groups'] = [copy.deepcopy(groups[0]) for _ in range(5)]
            with self.subTest(mutate=mutate):
                self.assertTrue(any('查询' in e for e in self.errors(data)))

    def test_candidate_and_findings_must_agree_on_adoption(self):
        data = handoff()
        data[2]['candidate_reviews'][0]['status'] = 'read-not-adopted'
        self.assertTrue(any('采用' in e for e in self.errors(data)))

    def test_coverage_cannot_reference_an_unknown_question(self):
        data = handoff()
        data[3]['coverage'][0]['question_id'] = 'invented'
        self.assertTrue(any('question_id' in e for e in self.errors(data)))


if __name__ == '__main__':
    unittest.main()
