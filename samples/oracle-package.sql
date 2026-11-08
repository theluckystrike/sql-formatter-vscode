SET SERVEROUTPUT ON
PROMPT Creating package emp_pkg
CREATE OR REPLACE PACKAGE emp_pkg AS
  PROCEDURE raise_salary(p_id IN NUMBER, p_pct IN NUMBER);
  FUNCTION full_name(p_id IN NUMBER) RETURN VARCHAR2;
END emp_pkg;
/
CREATE OR REPLACE PACKAGE BODY emp_pkg AS
  PROCEDURE raise_salary(p_id IN NUMBER, p_pct IN NUMBER) IS
    v_sal employees.salary%TYPE;
  BEGIN
    SELECT salary INTO v_sal FROM employees WHERE employee_id = p_id;
    IF v_sal IS NULL THEN RAISE NO_DATA_FOUND; END IF;
    UPDATE employees SET salary = salary * (1 + p_pct / 100) WHERE employee_id = p_id;
    dbms_output.put_line(q'[Raised by ']' || p_pct || '%');
  EXCEPTION
    WHEN NO_DATA_FOUND THEN dbms_output.put_line('No employee ' || p_id);
  END raise_salary;
  FUNCTION full_name(p_id IN NUMBER) RETURN VARCHAR2 IS
    v_name VARCHAR2(200);
  BEGIN
    SELECT first_name || ' ' || last_name INTO v_name FROM employees WHERE employee_id = p_id;
    RETURN v_name;
  END full_name;
END emp_pkg;
/
SELECT employee_id, NVL(commission_pct, 0) AS pct FROM employees WHERE ROWNUM <= 10;
