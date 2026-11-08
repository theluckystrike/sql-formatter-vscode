-- T-SQL: N'' strings, [names with spaces], GO batches
EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'Customer number' , @level0type=N'SCHEMA',@level0name=N'dbo', @level1type=N'TABLE',@level1name=N'Customers', @level2type=N'COLUMN',@level2name=N'id'
GO
CREATE PROCEDURE [dbo].[Get Customer Orders] @CustomerId INT, @Since DATETIME2 = NULL AS BEGIN SET NOCOUNT ON; IF @Since IS NULL SET @Since = DATEADD(DAY, -30, SYSUTCDATETIME()); BEGIN TRY SELECT TOP (50) o.[Order Id], o.[Order Date], c.[First Name] + N' ' + c.[Last Name] AS [Full Name] FROM [dbo].[Orders] AS o INNER JOIN [dbo].[Customers] c ON c.[Id] = o.[Customer Id] WHERE o.[Customer Id] = @CustomerId AND o.[Order Date] >= @Since ORDER BY o.[Order Date] DESC; END TRY BEGIN CATCH THROW; END CATCH END
GO
SELECT [weird]]name], N'Ünïcödé' AS label, @@ROWCOUNT AS n;
GO
