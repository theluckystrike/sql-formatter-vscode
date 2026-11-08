# MySQL dump style: DELIMITER blocks, backticks, backslash escapes
DROP PROCEDURE IF EXISTS `add_order`;
DELIMITER $$
CREATE DEFINER=`root`@`localhost` PROCEDURE `add_order`(IN cid INT, IN amt DECIMAL(10,2))
BEGIN
  DECLARE total DECIMAL(10,2) DEFAULT 0;
  IF amt > 100 THEN SET total = amt * 0.9; ELSE SET total = amt; END IF;
  INSERT INTO `orders`(`customer_id`, `amount`, `note`) VALUES (cid, total, 'it\'s \"done\"');
END$$

CREATE FUNCTION `price_band`(p DECIMAL(10,2)) RETURNS VARCHAR(10) DETERMINISTIC
BEGIN
  RETURN CASE WHEN p < 10 THEN 'low' WHEN p < 100 THEN 'mid' ELSE 'high' END;
END$$
DELIMITER ;

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
select o.id, c.`full name`, sum(o.amount) total from `orders` o join customers c on c.id = o.customer_id group by o.id, c.`full name` limit 10, 20;
