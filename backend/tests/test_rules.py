from app.rules import INCIDENT_TYPES, TEAM_KIND_LABELS, witness_question_text


def test_violent_types_start_with_warning():
    for incident_type in INCIDENT_TYPES.values():
        if incident_type.violent:
            assert witness_question_text(incident_type).startswith("Не се приближавайте!")


def test_other_types_start_without_warning():
    for incident_type in INCIDENT_TYPES.values():
        if not incident_type.violent:
            assert witness_question_text(incident_type).startswith("Наблизо")


def test_team_kinds_are_valid():
    for incident_type in INCIDENT_TYPES.values():
        assert incident_type.team_kinds
        for kind in incident_type.team_kinds:
            assert kind in TEAM_KIND_LABELS
